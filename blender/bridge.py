# French Flair — Pont MCP pour Blender headless.
# Lancé par : blender -b --python bridge.py
# Ouvre un serveur TCP (protocole compatible blender-mcp : JSON
# {"type": ..., "params": ...} -> {"status": "success"|"error", "result": ...})
# et exécute les commandes de modélisation dans la scène Blender.

import io
import json
import math
import os
import socket
import traceback
from contextlib import redirect_stdout

import bpy

HOST = os.environ.get("BRIDGE_HOST", "0.0.0.0")
PORT = int(os.environ.get("BRIDGE_PORT", "9876"))
OUTPUT_DIR = os.environ.get("BRIDGE_OUTPUT", "/output")

MAX_MESSAGE = 10 * 1024 * 1024  # 10 Mo


# ---------------------------------------------------------------------------
# Commandes
# ---------------------------------------------------------------------------

def cmd_ping(params):
    return {"pong": True, "blender": bpy.app.version_string}


def cmd_reset_scene(params):
    """Repart d'une scène totalement vide."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    return {"ok": True}


def cmd_execute_code(params):
    """Exécute du code Python (bpy) et renvoie ce qu'il a affiché."""
    code = params.get("code", "")
    if not code.strip():
        raise ValueError("Code vide")
    stdout = io.StringIO()
    namespace = {"bpy": bpy, "math": math, "__name__": "__bridge__"}
    with redirect_stdout(stdout):
        exec(compile(code, "<generated>", "exec"), namespace)
    out = stdout.getvalue()
    return {"executed": True, "output": out[-20000:]}


def _mesh_objects():
    return [o for o in bpy.context.scene.objects if o.type == "MESH"]


def cmd_scene_summary(params):
    """Résumé de la scène : objets, dimensions, polygones, matériaux."""
    objs = []
    total_polys = 0
    for o in bpy.context.scene.objects:
        entry = {
            "name": o.name,
            "type": o.type,
            "location": [round(v, 4) for v in o.location],
            "dimensions": [round(v, 4) for v in o.dimensions] if o.type == "MESH" else None,
        }
        if o.type == "MESH":
            entry["polygons"] = len(o.data.polygons)
            entry["materials"] = [m.name for m in o.data.materials if m]
            total_polys += entry["polygons"]
        objs.append(entry)

    # Boîte englobante globale des meshes
    bbox = None
    meshes = _mesh_objects()
    if meshes:
        from mathutils import Vector
        mins = Vector((1e9, 1e9, 1e9))
        maxs = Vector((-1e9, -1e9, -1e9))
        for o in meshes:
            for corner in o.bound_box:
                world = o.matrix_world @ Vector(corner)
                mins = Vector(map(min, mins, world))
                maxs = Vector(map(max, maxs, world))
        bbox = {
            "min": [round(v, 4) for v in mins],
            "max": [round(v, 4) for v in maxs],
            "size": [round(a - b, 4) for a, b in zip(maxs, mins)],
        }

    return {"objects": objs, "total_polygons": total_polys, "bbox": bbox}


def _frame_scene_bbox():
    """Centre et rayon englobant des meshes de la scène."""
    from mathutils import Vector
    meshes = _mesh_objects()
    if not meshes:
        return Vector((0, 0, 0)), 2.0
    mins = Vector((1e9, 1e9, 1e9))
    maxs = Vector((-1e9, -1e9, -1e9))
    for o in meshes:
        for corner in o.bound_box:
            world = o.matrix_world @ Vector(corner)
            mins = Vector(map(min, mins, world))
            maxs = Vector(map(max, maxs, world))
    center = (mins + maxs) / 2
    radius = max((maxs - mins).length / 2, 0.1)
    return center, radius


def cmd_render_views(params):
    """Rend la scène sous plusieurs angles (Cycles CPU) -> PNG."""
    from mathutils import Vector

    out_dir = params.get("out_dir", "renders")
    resolution = int(params.get("resolution", 512))
    samples = int(params.get("samples", 24))
    abs_dir = os.path.normpath(os.path.join(OUTPUT_DIR, out_dir))
    if not abs_dir.startswith(os.path.normpath(OUTPUT_DIR)):
        raise ValueError("Chemin de sortie invalide")
    os.makedirs(abs_dir, exist_ok=True)

    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = False
    scene.render.resolution_x = resolution
    scene.render.resolution_y = resolution
    scene.render.film_transparent = False

    if scene.world is None:
        scene.world = bpy.data.worlds.new("World")
    scene.world.use_nodes = True
    bg = scene.world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = (0.92, 0.90, 0.86, 1.0)
        bg.inputs[1].default_value = 1.0

    center, radius = _frame_scene_bbox()
    dist = radius * 2.6

    # Lumière soleil temporaire si aucune lumière
    temp_objects = []
    if not any(o.type == "LIGHT" for o in scene.objects):
        sun_data = bpy.data.lights.new("BridgeSun", type="SUN")
        sun_data.energy = 3.0
        sun = bpy.data.objects.new("BridgeSun", sun_data)
        scene.collection.objects.link(sun)
        sun.rotation_euler = (math.radians(50), 0, math.radians(30))
        temp_objects.append(sun)

    cam_data = bpy.data.cameras.new("BridgeCam")
    cam = bpy.data.objects.new("BridgeCam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    temp_objects.append(cam)

    views = [
        ("face", 0, 18),
        ("trois_quarts", 45, 28),
        ("arriere", 180, 22),
        ("dessus", 45, 70),
    ]
    files = []
    for name, azim_deg, elev_deg in views:
        azim = math.radians(azim_deg)
        elev = math.radians(elev_deg)
        cam.location = center + Vector((
            dist * math.cos(elev) * math.sin(azim),
            -dist * math.cos(elev) * math.cos(azim),
            dist * math.sin(elev),
        ))
        direction = center - cam.location
        cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
        filepath = os.path.join(abs_dir, f"render_{name}.png")
        scene.render.filepath = filepath
        bpy.ops.render.render(write_still=True)
        files.append(os.path.relpath(filepath, OUTPUT_DIR))

    for o in temp_objects:
        bpy.data.objects.remove(o, do_unlink=True)

    return {"renders": files}


def cmd_export_glb(params):
    """Exporte la scène complète en .glb (axe Y vers le haut, mètres)."""
    out_path = params.get("out_path")
    if not out_path:
        raise ValueError("out_path manquant")
    abs_path = os.path.normpath(os.path.join(OUTPUT_DIR, out_path))
    if not abs_path.startswith(os.path.normpath(OUTPUT_DIR)) or not abs_path.endswith(".glb"):
        raise ValueError("Chemin d'export invalide")
    os.makedirs(os.path.dirname(abs_path), exist_ok=True)

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=abs_path,
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        use_selection=False,
    )
    size = os.path.getsize(abs_path)
    return {"exported": os.path.relpath(abs_path, OUTPUT_DIR), "bytes": size}


COMMANDS = {
    "ping": cmd_ping,
    "reset_scene": cmd_reset_scene,
    "execute_code": cmd_execute_code,
    "scene_summary": cmd_scene_summary,
    "render_views": cmd_render_views,
    "export_glb": cmd_export_glb,
}


# ---------------------------------------------------------------------------
# Serveur TCP : un message JSON par connexion, réponse JSON, fermeture.
# ---------------------------------------------------------------------------

def read_message(conn):
    conn.settimeout(600)
    buf = b""
    while len(buf) < MAX_MESSAGE:
        chunk = conn.recv(65536)
        if not chunk:
            break
        buf += chunk
        try:
            return json.loads(buf.decode("utf-8"))
        except json.JSONDecodeError:
            continue  # message incomplet, on continue à lire
    raise ValueError("Message JSON invalide ou trop grand")


def serve():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((HOST, PORT))
    srv.listen(4)
    print(f"[bridge] Blender {bpy.app.version_string} — en écoute sur {HOST}:{PORT}", flush=True)

    while True:
        conn, addr = srv.accept()
        try:
            msg = read_message(conn)
            cmd = msg.get("type", "")
            params = msg.get("params", {}) or {}
            print(f"[bridge] {addr[0]} -> {cmd}", flush=True)
            handler = COMMANDS.get(cmd)
            if handler is None:
                response = {"status": "error", "message": f"Commande inconnue : {cmd}"}
            else:
                result = handler(params)
                response = {"status": "success", "result": result}
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            response = {"status": "error", "message": str(exc)}
        try:
            conn.sendall(json.dumps(response).encode("utf-8"))
        except OSError:
            pass
        finally:
            conn.close()


if __name__ == "__main__":
    serve()
