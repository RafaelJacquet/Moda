# French Flair — Scène « bureau » réaliste, point de vue FIXE au centre.
#
# Principe :
#  1. Géométrie détaillée (murs percés, parquet, plinthes, fenêtres à 2 vantaux,
#     radiateurs, rideaux, porte, prises, interrupteurs, dalles LED…).
#  2. Éclairage calculé dans Cycles (ciel = panorama du paysage + soleil) puis
#     « baké » dans des textures : le rendu three.js / Unity / Unreal est
#     identique au rendu Cycles, sans dépendre des lumières du moteur.
#     Les matériaux exportés sont « unlit » (KHR_materials_unlit).
#  3. Paysage flouté (bureau_paysage.source.py → panorama 360°) projeté sur des
#     plans placés juste derrière chaque fenêtre. La projection est exacte
#     depuis EYE (centre de la pièce, hauteur des yeux) : c'est pour cela que
#     le joueur ne doit pas se déplacer.
#
# Lancement (conteneur Blender) :
#   blender -b --python bureau.source.py -- <dossier_sortie> <paysage_flou.jpg> <sortie.glb>
#   BAKE_QUALITY=draft  → test rapide (textures /4, peu d'échantillons)
#
# Repère Blender : X = est, Y = nord, Z = haut (exporté en Y-haut dans le GLB).

import bpy, bmesh, math, os, sys, time
import numpy as np
from mathutils import Vector

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = ARGS[0] if len(ARGS) > 0 else "/output/scenes_build/bureau"
PANO = ARGS[1] if len(ARGS) > 1 else os.path.join(OUT, "paysage_flou.jpg")
GLB = ARGS[2] if len(ARGS) > 2 else os.path.join(OUT, "bureau.glb")
DRAFT = os.environ.get("BAKE_QUALITY", "final") == "draft"
os.makedirs(OUT, exist_ok=True)
T0 = time.time()

def log(*a):
    print(f"[bureau {time.time() - T0:6.1f}s]", *a, flush=True)

# --- Dimensions (mètres) ---------------------------------------------------
W, D, H, T = 6.0, 5.0, 2.7, 0.2      # intérieur X, intérieur Y, hauteur, épaisseur murs
hx, hy = W / 2, D / 2
EYE = Vector((0.0, 0.0, 1.6))         # point de vue fixe (doit = bureau_paysage.source.py)
SUN_ELEV, SUN_AZIM = 34.0, 112.0      # idem paysage
SUN_STRENGTH = 4.5
WORLD_STRENGTH = 1.0

PORTE = (1.8, 0.93, 0.0, 2.10)                        # mur sud (centre, largeur, bas, haut)
FEN_NORD = [(-1.5, 1.40, 0.90, 2.20), (1.5, 1.40, 0.90, 2.20)]
FEN_EST = [(0.0, 1.60, 0.90, 2.20)]

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.unit_settings.system = "METRIC"

# =========================================================================
# Matériaux (pour le calcul d'éclairage ; remplacés par des textures bakées)
# =========================================================================
def mat(name, rgb, rough=0.6, metal=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*rgb, 1)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    return m

def noise_color(m, c1, c2, scale, stretch=(1, 1, 1), detail=4, lo=0.35, hi=0.65):
    nt = m.node_tree
    p = nt.nodes["Principled BSDF"]
    tc = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = stretch
    tx = nt.nodes.new("ShaderNodeTexNoise")
    tx.inputs["Scale"].default_value = scale
    tx.inputs["Detail"].default_value = detail
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = lo
    ramp.color_ramp.elements[1].position = hi
    ramp.color_ramp.elements[0].color = (*c1, 1)
    ramp.color_ramp.elements[1].color = (*c2, 1)
    nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
    nt.links.new(mp.outputs["Vector"], tx.inputs["Vector"])
    nt.links.new(tx.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], p.inputs["Base Color"])
    return m

def parquet_image(size=2048, tile=2.0, seed=3):
    """Texture de parquet chêne (lames 14,3 cm, longueurs aléatoires), raccordable."""
    rng = np.random.default_rng(seed)
    n_rows = 14
    px = size / tile
    ys, xs = np.mgrid[0:size, 0:size].astype(np.float32)
    img = np.zeros((size, size, 3), np.float32)
    base = np.array([0.60, 0.46, 0.33], np.float32)      # chêne naturel (sRGB)
    row_h = size / n_rows
    for r in range(n_rows):
        y0, y1 = int(round(r * row_h)), int(round((r + 1) * row_h))
        yy, xx = ys[y0:y1], xs[y0:y1]
        # coupes de lames (raccord en X modulo la tuile)
        cuts, x = [], rng.uniform(0, size)
        start = x
        while x < start + size:
            cuts.append(x % size)
            x += rng.uniform(0.75, 1.5) * px
        cuts = np.sort(np.array(cuts))
        idx = np.searchsorted(cuts, xx, side="right") % len(cuts)
        tone = rng.normal(1.0, 0.045, len(cuts)).astype(np.float32)
        warm = rng.normal(0.0, 0.012, len(cuts)).astype(np.float32)
        phase = rng.uniform(0, 100, len(cuts)).astype(np.float32)
        t = tone[idx][..., None]
        col = base * t + np.stack([warm[idx], warm[idx] * 0.5, -warm[idx]], -1)
        # veinage : fines bandes le long des lames, ondulées
        v = (yy - y0) / row_h
        g = np.sin(2 * np.pi * (v * (6 + (phase[idx] % 5)) + 0.25 * np.sin(xx / px * 1.3 + phase[idx])))
        g2 = np.sin(2 * np.pi * (v * 23 + 0.1 * np.sin(xx / px * 3.1 + phase[idx] * 2)))
        col *= (1 + 0.045 * g + 0.025 * g2)[..., None]
        # joints : bords de rangée et bouts de lames
        edge = np.minimum(yy - y0, y1 - 1 - yy)
        d_cut = np.min(np.abs(xx[..., None] - cuts[None, None, :]), axis=-1)
        d_cut = np.minimum(d_cut, size - d_cut)
        seam = np.clip(np.minimum(edge, d_cut) / 2.0, 0, 1)
        col *= (0.72 + 0.28 * seam)[..., None]
        img[y0:y1] = col
    img = np.clip(img, 0, 1)
    im = bpy.data.images.new("Parquet_Chene", size, size, alpha=False)
    im.pixels.foreach_set(np.dstack([img, np.ones((size, size), np.float32)]).ravel())
    im.pack()
    return im

def parquet_mat():
    m = mat("Parquet_Chene", (0.4, 0.28, 0.17), 0.35)
    nt = m.node_tree
    tx = nt.nodes.new("ShaderNodeTexImage")
    tx.image = parquet_image(1024 if DRAFT else 2048)
    uv = nt.nodes.new("ShaderNodeUVMap")
    uv.uv_map = "UVMap"
    nt.links.new(uv.outputs["UV"], tx.inputs["Vector"])
    nt.links.new(tx.outputs["Color"], nt.nodes["Principled BSDF"].inputs["Base Color"])
    return m

M_PARQUET = parquet_mat()
M_PEINTURE = noise_color(mat("Peinture_Mur", (0.72, 0.70, 0.66), 0.9),
                         (0.70, 0.68, 0.64), (0.74, 0.72, 0.68), 14, detail=6)
M_PLAFOND = noise_color(mat("Peinture_Plafond", (0.78, 0.78, 0.77), 0.95),
                        (0.77, 0.77, 0.76), (0.80, 0.80, 0.79), 10)
M_BLANC = mat("Laque_Blanche", (0.80, 0.80, 0.79), 0.35)
M_PLASTIQUE = mat("Plastique_Blanc", (0.78, 0.78, 0.76), 0.4)
M_NOIR = mat("Plastique_Noir", (0.03, 0.03, 0.03), 0.5)
M_ALU = mat("Alu_Anthracite", (0.055, 0.06, 0.065), 0.45)       # menuiseries RAL 7016
M_INOX = mat("Inox_Brosse", (0.45, 0.45, 0.46), 0.3)             # (métal approché en diffus)
M_PIERRE = noise_color(mat("Pierre_Appui", (0.55, 0.53, 0.49), 0.8),
                       (0.50, 0.48, 0.44), (0.60, 0.58, 0.54), 25)
M_CHENE = noise_color(mat("Placage_Chene", (0.45, 0.31, 0.18), 0.45),
                      (0.38, 0.25, 0.14), (0.52, 0.37, 0.22), 6, stretch=(30, 30, 1.5), detail=8)
M_LIN = noise_color(mat("Voilage_Lin", (0.70, 0.66, 0.58), 0.95),
                    (0.66, 0.62, 0.54), (0.74, 0.70, 0.62), 40, stretch=(1, 1, 8))
M_RADIATEUR = mat("Radiateur_Blanc", (0.80, 0.80, 0.80), 0.3)
M_FACADE = mat("Facade_Enduit", (0.72, 0.70, 0.66), 0.9)
M_VERRE = mat("Verre", (0.92, 0.96, 0.97), 0.02)
M_VERRE.node_tree.nodes["Principled BSDF"].inputs["Alpha"].default_value = 0.10
M_VERRE.blend_method = "BLEND"
M_VERRE.use_backface_culling = True
M_LED = bpy.data.materials.new("Dalle_LED")
M_LED.use_nodes = True
_nt = M_LED.node_tree
_nt.nodes.remove(_nt.nodes["Principled BSDF"])
_em = _nt.nodes.new("ShaderNodeEmission")
_em.inputs["Color"].default_value = (1.0, 0.96, 0.90, 1)
_em.inputs["Strength"].default_value = 4.0
_nt.links.new(_em.outputs[0], _nt.nodes["Material Output"].inputs["Surface"])

# =========================================================================
# Construction : géométrie regroupée par « lot de bake »
# =========================================================================
class Group:
    def __init__(self, name):
        self.name, self.bm, self.mats = name, bmesh.new(), []

    def mi(self, m):
        if m not in self.mats:
            self.mats.append(m)
        return self.mats.index(m)

GROUPS = {}
def G(name):
    return GROUPS.setdefault(name, Group(name))

FACES = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]

def box(g, m, x0, x1, y0, y1, z0, z1):
    x0, x1 = sorted((x0, x1)); y0, y1 = sorted((y0, y1)); z0, z1 = sorted((z0, z1))
    i = g.mi(m)
    vs = [g.bm.verts.new((x, y, z)) for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)]
    for f in FACES:   # sommets ordonnés : normales sortantes
        g.bm.faces.new([vs[k] for k in f]).material_index = i

def merge(g, tb, m, smooth=False):
    bmesh.ops.recalc_face_normals(tb, faces=tb.faces)
    i = g.mi(m)
    vmap = {v: g.bm.verts.new(v.co) for v in tb.verts}
    for f in tb.faces:
        nf = g.bm.faces.new([vmap[v] for v in f.verts])
        nf.material_index, nf.smooth = i, smooth
    tb.free()

def cyl(g, m, p0, p1, r, segs=16):
    p0, p1 = Vector(p0), Vector(p1)
    a = (p1 - p0).normalized()
    u = a.orthogonal().normalized()
    v = a.cross(u)
    tb = bmesh.new()
    rings = []
    for p in (p0, p1):
        rings.append([tb.verts.new(p + r * (math.cos(2 * math.pi * k / segs) * u +
                                            math.sin(2 * math.pi * k / segs) * v)) for k in range(segs)])
    for k in range(segs):
        k2 = (k + 1) % segs
        tb.faces.new((rings[0][k], rings[0][k2], rings[1][k2], rings[1][k]))
    tb.faces.new(rings[0][::-1])
    tb.faces.new(rings[1])
    merge(g, tb, m, smooth=True)

# Repères locaux de mur : s = le long du mur, t = distance au parement intérieur
# (positive vers la pièce, négative dans l'épaisseur du mur), z = hauteur.
WALLS = {
    "N": lambda s, t, z: (s, hy - t, z),
    "S": lambda s, t, z: (s, -hy + t, z),
    "E": lambda s, t, z: (hx - t, s, z),
    "O": lambda s, t, z: (-hx + t, s, z),
}

def lbox(g, m, wall, s0, s1, t0, t1, z0, z1):
    a, b = WALLS[wall](s0, t0, z0), WALLS[wall](s1, t1, z1)
    box(g, m, a[0], b[0], a[1], b[1], a[2], b[2])

def lcyl(g, m, wall, p0, p1, r, segs=16):
    cyl(g, m, WALLS[wall](*p0), WALLS[wall](*p1), r, segs)

# ---------------------------------------------------------------- murs (booléens)
def mesh_box_obj(name, x0, x1, y0, y1, z0, z1):
    g = Group(name)
    box(g, M_PEINTURE, x0, x1, y0, y1, z0, z1)
    me = bpy.data.meshes.new(name)
    g.bm.to_mesh(me); g.bm.free()
    ob = bpy.data.objects.new(name, me)
    sc.collection.objects.link(ob)
    return ob

def build_walls():
    shell = mesh_box_obj("Murs_tmp", -hx - T, hx + T, -hy - T, hy + T, 0, H)
    cutters = [mesh_box_obj("cut", -hx, hx, -hy, hy, -1, H + 1)]
    def opening(wall, op):
        c, w, zb, zt = op
        a = WALLS[wall](c - w / 2, 0.5, zb)
        b = WALLS[wall](c + w / 2, -T - 0.5, zt)
        cutters.append(mesh_box_obj("cut", min(a[0], b[0]), max(a[0], b[0]),
                                    min(a[1], b[1]), max(a[1], b[1]), zb, zt))
    opening("S", PORTE)
    for op in FEN_NORD:
        opening("N", op)
    for op in FEN_EST:
        opening("E", op)
    bpy.context.view_layer.objects.active = shell
    for i, cobj in enumerate(cutters):
        mod = shell.modifiers.new(f"b{i}", "BOOLEAN")
        mod.operation, mod.object, mod.solver = "DIFFERENCE", cobj, "EXACT"
        bpy.ops.object.modifier_apply(modifier=mod.name)
    for cobj in cutters:
        bpy.data.objects.remove(cobj, do_unlink=True)
    # Répartition : parement intérieur + tableaux (bakés) / façade extérieure
    bm = bmesh.new()
    bm.from_mesh(shell.data)
    bpy.data.objects.remove(shell, do_unlink=True)
    g_in, g_out = G("Murs"), G("Facade")
    i_in, i_out = g_in.mi(M_PEINTURE), g_out.mi(M_FACADE)
    for f in bm.faces:
        c, n = f.calc_center_median(), f.normal
        if n.z < -0.9 and c.z < 0.01:
            continue                                       # dessous des murs
        outer = ((n.z > 0.9 and c.z > H - 0.01) or
                 (abs(c.x) > hx + T - 0.01 and abs(n.x) > 0.9) or
                 (abs(c.y) > hy + T - 0.01 and abs(n.y) > 0.9))
        g, i = (g_out, i_out) if outer else (g_in, i_in)
        vm = [g.bm.verts.new(v.co) for v in f.verts]
        g.bm.faces.new(vm).material_index = i
    bm.free()

build_walls()

# ---------------------------------------------------------------- sol / plafond
def plane(g, m, pts, uv_scale=None):
    i = g.mi(m)
    vs = [g.bm.verts.new(p) for p in pts]
    f = g.bm.faces.new(vs)
    f.material_index = i
    if uv_scale:
        uvl = g.bm.loops.layers.uv.get("UVMap") or g.bm.loops.layers.uv.new("UVMap")
        for loop in f.loops:
            loop[uvl].uv = (loop.vert.co.x / uv_scale, loop.vert.co.y / uv_scale)
    return f

e = 0.1   # débord sous les murs (étanchéité lumineuse)
plane(G("Sol"), M_PARQUET, [(-hx - e, -hy - e, 0), (hx + e, -hy - e, 0),
                            (hx + e, hy + e, 0), (-hx - e, hy + e, 0)], uv_scale=2.0)
plane(G("Plafond"), M_PLAFOND, [(-hx - e, -hy - e, H), (-hx - e, hy + e, H),
                                (hx + e, hy + e, H), (hx + e, -hy - e, H)])   # normale vers le bas

# ---------------------------------------------------------------- plinthes
PH, PT = 0.08, 0.012
g = G("Murs")
pc, pw = PORTE[0], PORTE[1]
for wall, (a, b) in (("N", (-hx, hx)), ("E", (-hy + PT, hy - PT)), ("O", (-hy + PT, hy - PT))):
    lbox(g, M_BLANC, wall, a, b, 0, PT, 0, PH)
lbox(g, M_BLANC, "S", -hx, pc - pw / 2 - 0.05, 0, PT, 0, PH)
lbox(g, M_BLANC, "S", pc + pw / 2 + 0.05, hx, 0, PT, 0, PH)

# ---------------------------------------------------------------- fenêtres
def window(name, wall, op):
    c, w, zb, zt = op
    s0, s1 = c - w / 2, c + w / 2
    g = G(name)
    gv = G("Vitrages")
    FT0, FT1 = -0.13, -0.06       # dormant (épaisseur dans le mur)
    fw = 0.05
    lbox(g, M_ALU, wall, s0, s0 + fw, FT0, FT1, zb, zt)
    lbox(g, M_ALU, wall, s1 - fw, s1, FT0, FT1, zb, zt)
    lbox(g, M_ALU, wall, s0, s1, FT0, FT1, zb, zb + fw)
    lbox(g, M_ALU, wall, s0, s1, FT0, FT1, zt - fw, zt)
    # deux ouvrants
    ST0, ST1 = -0.12, -0.052
    sw, sb = 0.065, 0.085
    for a, b in ((s0 + fw - 0.012, c), (c, s1 - fw + 0.012)):
        za, zb2 = zb + fw - 0.012, zt - fw + 0.012
        lbox(g, M_ALU, wall, a, a + sw, ST0, ST1, za, zb2)
        lbox(g, M_ALU, wall, b - sw, b, ST0, ST1, za, zb2)
        lbox(g, M_ALU, wall, a, b, ST0, ST1, za, za + sb)
        lbox(g, M_ALU, wall, a, b, ST0, ST1, zb2 - sw, zb2)
        # parcloses intérieures (petit relief)
        lbox(g, M_ALU, wall, a + sw, b - sw, ST1 - 0.004, ST1 + 0.006, za + sb, za + sb + 0.012)
        lbox(g, M_ALU, wall, a + sw, b - sw, ST1 - 0.004, ST1 + 0.006, zb2 - sw - 0.012, zb2 - sw)
        # double vitrage
        lbox(gv, M_VERRE, wall, a + sw - 0.01, b - sw + 0.01, -0.098, -0.074, za + sb - 0.01, zb2 - sw + 0.01)
    # crémone (poignée) sur l'ouvrant de droite
    zh = zb + 0.52 * (zt - zb)
    lbox(g, M_BLANC, wall, c + 0.018, c + 0.048, ST1, ST1 + 0.012, zh - 0.07, zh + 0.07)
    lcyl(g, M_BLANC, wall, (c + 0.033, ST1 + 0.012, zh), (c + 0.033, ST1 + 0.03, zh), 0.009, 12)
    lbox(g, M_BLANC, wall, c + 0.026, c + 0.040, ST1 + 0.022, ST1 + 0.038, zh - 0.12, zh + 0.005)
    # tablette intérieure + appui extérieur
    lbox(g, M_BLANC, wall, s0 - 0.04, s1 + 0.04, FT0, 0.035, zb - 0.005, zb + 0.02)
    lbox(g, M_PIERRE, wall, s0 - 0.05, s1 + 0.05, -T - 0.05, FT0, zb - 0.045, zb + 0.012)
    return s0, s1, zt

def radiator(wall, c, w):
    g = G("Radiateurs")
    rw = w - 0.34
    a, b = c - rw / 2, c + rw / 2
    z0, z1 = 0.16, 0.76
    lbox(g, M_RADIATEUR, wall, a, b, 0.035, 0.055, z0, z1)            # panneau arrière
    lbox(g, M_RADIATEUR, wall, a, b, 0.085, 0.105, z0, z1)            # panneau avant
    lbox(g, M_RADIATEUR, wall, a, b, 0.035, 0.105, z1 - 0.004, z1 + 0.004)   # grille dessus
    for s in (a, b - 0.004):
        lbox(g, M_RADIATEUR, wall, s, s + 0.004, 0.035, 0.105, z0, z1)       # joues
    s = a + 0.025
    while s < b - 0.02:                                                # cannelures
        lbox(g, M_RADIATEUR, wall, s - 0.009, s + 0.009, 0.105, 0.111, z0 + 0.03, z1 - 0.03)
        s += 0.05
    for sx in (a - 0.04, b + 0.04):                                    # tuyaux + robinets
        lcyl(g, M_RADIATEUR, wall, (sx, 0.06, 0.0), (sx, 0.06, 0.24), 0.008, 10)
        lcyl(g, M_RADIATEUR, wall, (sx, 0.06, 0.22), ((a if sx < a else b), 0.06, 0.22), 0.008, 10)
    lcyl(g, M_PLASTIQUE, wall, (b + 0.04, 0.06, 0.24), (b + 0.04, 0.06, 0.33), 0.024, 20)

def curtains(wall, s0, s1, zt):
    g = G("Rideaux")
    zr = zt + 0.18
    tr = 0.15
    lcyl(g, M_INOX, wall, (s0 - 0.38, tr, zr), (s1 + 0.38, tr, zr), 0.011, 12)    # tringle
    for s in (s0 - 0.30, s1 + 0.30):                                              # supports
        lcyl(g, M_INOX, wall, (s, 0.0, zr), (s, tr + 0.01, zr), 0.007, 8)
    for a, b in ((s0 - 0.34, s0 + 0.06), (s1 - 0.06, s1 + 0.34)):
        tb = bmesh.new()
        n = 48
        z_lo, z_hi = 0.012, zr - 0.02
        front, back = [], []
        for k in range(n + 1):
            s = a + (b - a) * k / n
            dt = 0.045 * math.sin(2 * math.pi * (s - a) / 0.105)
            for lst, off in ((front, 0.004), (back, -0.004)):
                lst.append((tb.verts.new(WALLS[wall](s, tr + dt + off, z_lo)),
                            tb.verts.new(WALLS[wall](s, tr + dt + off, z_hi))))
        for k in range(n):
            tb.faces.new((front[k][0], front[k + 1][0], front[k + 1][1], front[k][1]))
            tb.faces.new((back[k][0], back[k][1], back[k + 1][1], back[k + 1][0]))
            tb.faces.new((front[k][0], back[k][0], back[k + 1][0], front[k + 1][0]))
            tb.faces.new((front[k][1], front[k + 1][1], back[k + 1][1], back[k][1]))
        for k in (0, n):
            tb.faces.new((front[k][0], front[k][1], back[k][1], back[k][0]))
        merge(g, tb, M_LIN, smooth=True)

for i, op in enumerate(FEN_NORD, 1):
    s0, s1, zt = window(f"Fenetre_Nord_{i}", "N", op)
    radiator("N", op[0], op[1])
    curtains("N", s0, s1, zt)
s0, s1, zt = window("Fenetre_Est", "E", FEN_EST[0])
radiator("E", FEN_EST[0][0], FEN_EST[0][1])
curtains("E", s0, s1, zt)

# ---------------------------------------------------------------- porte
c, w, zb, zt = PORTE
s0, s1 = c - w / 2, c + w / 2
g = G("Porte")
lbox(g, M_BLANC, "S", s0, s0 + 0.02, -T, 0, 0, zt)                  # huisserie
lbox(g, M_BLANC, "S", s1 - 0.02, s1, -T, 0, 0, zt)
lbox(g, M_BLANC, "S", s0, s1, -T, 0, zt - 0.02, zt)
for t0, t1 in ((0, 0.012), (-T - 0.012, -T)):                       # chambranles 2 faces
    lbox(g, M_BLANC, "S", s0 - 0.05, s0 + 0.02, t0, t1, 0, zt + 0.05)
    lbox(g, M_BLANC, "S", s1 - 0.02, s1 + 0.05, t0, t1, 0, zt + 0.05)
    lbox(g, M_BLANC, "S", s0 - 0.05, s1 + 0.05, t0, t1, zt - 0.02, zt + 0.05)
for a, b in ((s0 + 0.02, s0 + 0.035), (s1 - 0.035, s1 - 0.02)):     # butées
    lbox(g, M_BLANC, "S", a, b, -0.085, -0.065, 0, zt - 0.02)
lbox(g, M_BLANC, "S", s0 + 0.02, s1 - 0.02, -0.085, -0.065, zt - 0.035, zt - 0.02)
lbox(g, M_CHENE, "S", s0 + 0.023, s1 - 0.023, -0.065, -0.025, 0.008, zt - 0.023)   # vantail
lbox(g, M_CHENE, "S", s0, s1, -T, 0.0, 0.0, 0.006)                  # seuil
hs = s0 + 0.023 + 0.065                                              # poignée côté gauche
lcyl(g, M_INOX, "S", (hs, -0.025, 1.05), (hs, -0.016, 1.05), 0.026, 24)       # rosace
lcyl(g, M_INOX, "S", (hs, -0.016, 1.05), (hs, 0.035, 1.05), 0.008, 12)        # carré
lcyl(g, M_INOX, "S", (hs - 0.004, 0.035, 1.05), (hs + 0.13, 0.035, 1.05), 0.0095, 12)   # béquille
lcyl(g, M_INOX, "S", (hs, -0.025, 0.95), (hs, -0.016, 0.95), 0.02, 20)        # entrée de clé
lbox(g, M_NOIR, "S", hs - 0.003, hs + 0.003, -0.016, -0.015, 0.94, 0.96)
for zz in (0.25, 1.05, 1.85):                                       # paumelles
    lcyl(g, M_INOX, "S", (s1 - 0.023, -0.02, zz - 0.055), (s1 - 0.023, -0.02, zz + 0.055), 0.008, 12)

# ---------------------------------------------------------------- équipements
g = G("Equipements")
def switch(wall, s, z):
    lbox(g, M_PLASTIQUE, wall, s - 0.042, s + 0.042, 0, 0.008, z - 0.042, z + 0.042)
    lbox(g, M_PLASTIQUE, wall, s - 0.026, s + 0.026, 0.008, 0.013, z - 0.026, z + 0.026)

def outlet(wall, s, z=0.30, n=1):
    wd = 0.084 + (n - 1) * 0.071
    lbox(g, M_PLASTIQUE, wall, s - wd / 2, s + wd / 2, 0, 0.009, z - 0.042, z + 0.042)
    for k in range(n):
        sc_ = s - wd / 2 + 0.042 + k * 0.071
        lcyl(g, M_PLASTIQUE, wall, (sc_, 0.009, z), (sc_, 0.004, z), 0.024, 24)       # puits
        for ds in (-0.0095, 0.0095):
            lbox(g, M_NOIR, wall, sc_ + ds - 0.0025, sc_ + ds + 0.0025, 0.0035, 0.0045, z - 0.0025, z + 0.0025)

switch("S", s0 - 0.20, 1.05)
switch("S", s0 - 0.20 - 0.086, 1.05)
outlet("S", s0 - 0.25, n=2)
outlet("S", -1.4, n=2)
outlet("O", -1.2, n=3)
outlet("O", 1.2, n=2)
outlet("N", 0.0, n=2)
outlet("E", -1.6)
# thermostat d'ambiance
lbox(g, M_PLASTIQUE, "S", 0.55, 0.64, 0, 0.022, 1.42, 1.54)
lbox(g, M_NOIR, "S", 0.565, 0.625, 0.022, 0.023, 1.49, 1.525)
# bouche de VMC, détecteur de fumée (plafond)
cyl(g, M_PLASTIQUE, (-2.4, -1.9, H), (-2.4, -1.9, H - 0.012), 0.09, 32)
cyl(g, M_NOIR, (-2.4, -1.9, H - 0.012), (-2.4, -1.9, H - 0.013), 0.055, 32)
cyl(g, M_PLASTIQUE, (-2.4, -1.9, H - 0.013), (-2.4, -1.9, H - 0.03), 0.035, 32)
cyl(g, M_PLASTIQUE, (0.6, -0.9, H), (0.6, -0.9, H - 0.04), 0.055, 32)
# dalles LED 60x60 encastrées : cadre (baké) + diffuseur (lumineux)
g_led = G("Dalles_LED")
for x in (-1.5, 1.5):
    for y in (-0.0,):
        q = 0.3
        box(g, M_BLANC, x - q, x + q, y - q, y - q + 0.02, H - 0.012, H)
        box(g, M_BLANC, x - q, x + q, y + q - 0.02, y + q, H - 0.012, H)
        box(g, M_BLANC, x - q, x - q + 0.02, y - q, y + q, H - 0.012, H)
        box(g, M_BLANC, x + q - 0.02, x + q, y - q, y + q, H - 0.012, H)
        r = q - 0.02
        plane(g_led, M_LED, [(x - r, y - r, H - 0.006), (x - r, y + r, H - 0.006),
                             (x + r, y + r, H - 0.006), (x + r, y - r, H - 0.006)])

# ---------------------------------------------------------------- objets Blender
def finish(g):
    me = bpy.data.meshes.new(g.name)
    g.bm.to_mesh(me); g.bm.free()
    for m in g.mats:
        me.materials.append(m)
    ob = bpy.data.objects.new(g.name, me)
    sc.collection.objects.link(ob)
    return ob

OBJ = {name: finish(g) for name, g in GROUPS.items()}
log("géométrie :", {k: len(v.data.polygons) for k, v in OBJ.items()})

# =========================================================================
# Paysage : plans de fond derrière chaque fenêtre, UV = projection depuis EYE
# =========================================================================
def eq_uv(p):
    d = (Vector(p) - EYE).normalized()
    u = 0.5 - math.atan2(d.y, d.x) / (2 * math.pi)
    v = 0.5 + math.asin(max(-1, min(1, d.z))) / math.pi
    return u, v

def backdrop(name, wall, op):
    c, w, zb, zt = op
    t_plane = -T - 0.09                              # juste devant l'appui extérieur
    # étendue : projection des bords intérieurs de la baie sur le plan (+ marge)
    def proj(s, z):
        p = Vector(WALLS[wall](s, 0.0, z))
        q = Vector(WALLS[wall](0, t_plane, 0))
        n = (Vector(WALLS[wall](0, -1, 0)) - Vector(WALLS[wall](0, 0, 0))).normalized()
        k = (q - EYE).dot(n) / (p - EYE).dot(n)
        return EYE + (p - EYE) * k
    corners = [proj(s, z) for s in (c - w / 2, c + w / 2) for z in (zb, zt)]
    # coordonnées locales des coins projetés
    if wall in ("N", "S"):
        ss = [p.x for p in corners]
    else:
        ss = [p.y for p in corners]
    zs = [p.z for p in corners]
    m = 0.25
    sa, sb, za, zb_ = min(ss) - m, max(ss) + m, min(zs) - m, max(zs) + m
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new("UVMap")
    N, M = 32, 24
    vs = [[bm.verts.new(WALLS[wall](sa + (sb - sa) * i / N, t_plane, za + (zb_ - za) * j / M))
           for i in range(N + 1)] for j in range(M + 1)]
    for j in range(M):
        for i in range(N):
            f = bm.faces.new((vs[j][i], vs[j][i + 1], vs[j + 1][i + 1], vs[j + 1][i]))
            if f.normal.dot(EYE - f.calc_center_median()) < 0:
                f.normal_flip()
            for loop in f.loops:
                loop[uvl].uv = eq_uv(loop.vert.co)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me)
    sc.collection.objects.link(ob)
    return ob

BACKDROPS = [backdrop(f"Paysage_Nord_{i}", "N", op) for i, op in enumerate(FEN_NORD, 1)]
BACKDROPS.append(backdrop("Paysage_Est", "E", FEN_EST[0]))

# Recadrage du panorama sur la zone réellement visible (texture plus légère)
pano = bpy.data.images.load(PANO)
PW, PH_ = pano.size
pa = np.empty(PW * PH_ * 4, np.float32)
pano.pixels.foreach_get(pa)
pa = pa.reshape(PH_, PW, 4)
allu, allv = [], []
for ob in BACKDROPS:
    for d in ob.data.uv_layers["UVMap"].data:
        allu.append(d.uv.x); allv.append(d.uv.y)
u0, u1 = max(0, min(allu) - 0.005), min(1, max(allu) + 0.005)
v0, v1 = max(0, min(allv) - 0.005), min(1, max(allv) + 0.005)
x0, x1 = int(u0 * PW), int(math.ceil(u1 * PW))
y0, y1 = int(v0 * PH_), int(math.ceil(v1 * PH_))
crop = pa[y0:y1, x0:x1].copy()
crop_img = bpy.data.images.new("Paysage_Fenetres", x1 - x0, y1 - y0, alpha=False)
crop_img.pixels.foreach_set(crop.ravel())
crop_path = os.path.join(OUT, "paysage_fenetres.jpg")
crop_img.filepath_raw = crop_path
crop_img.file_format = "JPEG"
crop_img.save()
for ob in BACKDROPS:
    for d in ob.data.uv_layers["UVMap"].data:
        d.uv = ((d.uv.x * PW - x0) / (x1 - x0), (d.uv.y * PH_ - y0) / (y1 - y0))
log(f"panorama recadré : {x1 - x0}x{y1 - y0}")

def unlit_mat(name, image, uv="UVMap", color=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    m.use_backface_culling = True
    nt = m.node_tree
    nt.nodes.remove(nt.nodes["Principled BSDF"])
    out = nt.nodes["Material Output"]
    if image is None:
        rgb = nt.nodes.new("ShaderNodeRGB")
        rgb.outputs[0].default_value = (*color, 1)
        nt.links.new(rgb.outputs[0], out.inputs["Surface"])
    else:
        tx = nt.nodes.new("ShaderNodeTexImage")
        tx.image = image
        tx.extension = "EXTEND"
        uvn = nt.nodes.new("ShaderNodeUVMap")
        uvn.uv_map = uv
        nt.links.new(uvn.outputs["UV"], tx.inputs["Vector"])
        nt.links.new(tx.outputs["Color"], out.inputs["Surface"])   # couleur → sortie = unlit
    return m

M_PAYSAGE = unlit_mat("Paysage_Flou", bpy.data.images.load(crop_path))
for ob in BACKDROPS:
    ob.data.materials.append(M_PAYSAGE)

# =========================================================================
# Éclairage : ciel (panorama) + soleil
# =========================================================================
world = bpy.data.worlds.new("Ciel")
sc.world = world
world.use_nodes = True
wn = world.node_tree
env = wn.nodes.new("ShaderNodeTexEnvironment")
env.image = pano
wn.links.new(env.outputs["Color"], wn.nodes["Background"].inputs["Color"])
wn.nodes["Background"].inputs["Strength"].default_value = WORLD_STRENGTH

el, az = math.radians(SUN_ELEV), math.radians(SUN_AZIM)
to_sun = Vector((math.sin(az) * math.cos(el), math.cos(az) * math.cos(el), math.sin(el)))
sun_data = bpy.data.lights.new("Soleil", "SUN")
sun_data.energy = SUN_STRENGTH
sun_data.angle = math.radians(1.0)
sun_data.color = (1.0, 0.95, 0.88)
sun = bpy.data.objects.new("Soleil", sun_data)
sc.collection.objects.link(sun)
sun.rotation_euler = (-to_sun).to_track_quat("-Z", "Y").to_euler()

# Les plans de paysage et les vitrages ne bloquent pas la lumière
for ob in BACKDROPS + [OBJ["Vitrages"]]:
    ob.visible_diffuse = ob.visible_glossy = ob.visible_shadow = False
    ob.visible_transmission = ob.visible_volume_scatter = False

sc.render.engine = "CYCLES"
sc.cycles.device = "CPU"
sc.cycles.use_denoising = False
sc.cycles.max_bounces = 6
sc.cycles.diffuse_bounces = 4
sc.cycles.glossy_bounces = 1
sc.cycles.transmission_bounces = 2
sc.cycles.caustics_reflective = sc.cycles.caustics_refractive = False
sc.cycles.sample_clamp_indirect = 6.0

# =========================================================================
# Bake : albédo (haute déf.) × éclairement (basse déf., lissé) → texture finale
# =========================================================================
BAKE = {   # groupe : (résolution albédo, résolution éclairement)
    "Sol": (4096, 1024),
    "Murs": (2048, 1024),
    "Plafond": (1024, 512),
    "Fenetre_Nord_1": (1024, 256),
    "Fenetre_Nord_2": (1024, 256),
    "Fenetre_Est": (1024, 256),
    "Rideaux": (1024, 512),
    "Radiateurs": (2048, 1024),
    "Porte": (1024, 256),
    "Equipements": (1024, 256),
}
SAMPLES_IRR = 32 if DRAFT else 300
SAMPLES_ALB = 2 if DRAFT else 8
if DRAFT:
    BAKE = {k: (max(128, a // 4), max(64, b // 4)) for k, (a, b) in BAKE.items()}

def select_only(ob):
    bpy.ops.object.select_all(action="DESELECT")
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob

def lightmap_uv(ob, irr_res):
    me = ob.data
    uv = me.uv_layers.new(name="Lightmap")
    me.uv_layers.active = uv
    uv.active_render = True
    select_only(ob)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=max(0.004, 4.0 / irr_res),
                             area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode="OBJECT")

def bake(ob, res, passes, samples, margin):
    img = bpy.data.images.new(f"bake_{ob.name}_{res}", res, res, alpha=True, float_buffer=True)
    img.generated_color = (0, 0, 0, 0)
    for slot in ob.material_slots:
        nt = slot.material.node_tree
        n = nt.nodes.get("BakeTarget") or nt.nodes.new("ShaderNodeTexImage")
        n.name = "BakeTarget"
        n.image = img
        nt.nodes.active = n
    sc.cycles.samples = samples
    select_only(ob)
    bpy.ops.object.bake(type="DIFFUSE", pass_filter=passes, margin=margin,
                        margin_type="EXTEND", use_clear=False, target="IMAGE_TEXTURES")
    a = np.empty(res * res * 4, np.float32)
    img.pixels.foreach_get(a)
    bpy.data.images.remove(img)
    return a.reshape(res, res, 4)

def blur(a, sigma, axis):
    r = int(sigma * 3) + 1
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    pad = [(0, 0)] * a.ndim
    pad[axis] = (r, r)
    p = np.pad(a, pad, mode="edge")
    out = np.zeros_like(a)
    n = a.shape[axis]
    for i, wgt in enumerate(k):
        sl = [slice(None)] * a.ndim
        sl[axis] = slice(i, i + n)
        out += wgt * p[tuple(sl)]
    return out

def upsample(a, R):
    r = a.shape[0]
    x = (np.arange(R) + 0.5) * r / R - 0.5
    i0 = np.clip(np.floor(x).astype(int), 0, r - 1)
    i1 = np.clip(i0 + 1, 0, r - 1)
    f = np.clip(x - np.floor(x), 0, 1).astype(np.float32)
    rows = a[i0] * (1 - f)[:, None, None] + a[i1] * f[:, None, None]
    return rows[:, i0] * (1 - f)[None, :, None] + rows[:, i1] * f[None, :, None]

RADIANCE = {}
for name, (ra, ri) in BAKE.items():
    ob = OBJ[name]
    lightmap_uv(ob, ri)
    alb = bake(ob, ra, {"COLOR"}, SAMPLES_ALB, max(4, ra // 128))
    irr = bake(ob, ri, {"DIRECT", "INDIRECT"}, SAMPLES_IRR, max(3, ri // 64))
    wgt = irr[..., 3:4]
    s = 1.2 if ri >= 256 else 0.8
    num = blur(blur(irr[..., :3] * wgt, s, 0), s, 1)
    den = blur(blur(wgt, s, 0), s, 1)
    irr_s = num / np.maximum(den, 1e-4)
    rad = alb[..., :3] * upsample(irr_s, ra)
    RADIANCE[name] = (rad, alb[..., 3] > 0.5)
    log(f"bake {name}: albédo {ra}px, éclairement {ri}px, couverture {RADIANCE[name][1].mean():.0%}")

# Exposition globale : la médiane des murs → gris moyen agréable
rad, mask = RADIANCE["Murs"]
lum = (rad[..., 0] * 0.2126 + rad[..., 1] * 0.7152 + rad[..., 2] * 0.0722)[mask]
EXPO = float(os.environ.get("BAKE_EXPOSURE_TARGET", "0.62")) / max(np.median(lum), 1e-6)
log(f"exposition : x{EXPO:.3f}")

def tonemap(x):
    x = np.maximum(x * EXPO, 0)
    WHITE = 5.0
    y = x * (1 + x / (WHITE * WHITE)) / (1 + x)                  # Reinhard étendu
    y = np.clip(y, 0, 1)
    return np.where(y <= 0.0031308, 12.92 * y, 1.055 * np.power(y, 1 / 2.4) - 0.055)

TEX_DIR = os.path.join(OUT, "textures")
os.makedirs(TEX_DIR, exist_ok=True)
for name, (rad, mask) in RADIANCE.items():
    res = rad.shape[0]
    rgb = tonemap(rad).astype(np.float32)
    im = bpy.data.images.new(f"LM_{name}", res, res, alpha=False)
    im.pixels.foreach_set(np.dstack([rgb, np.ones((res, res), np.float32)]).ravel())
    path = os.path.join(TEX_DIR, f"{name}.jpg")
    im.filepath_raw = path
    im.file_format = "JPEG"
    im.save()
    bpy.data.images.remove(im)
    ob = OBJ[name]
    ob.data.materials.clear()
    ob.data.materials.append(unlit_mat(f"{name}_Bake", bpy.data.images.load(path), uv="Lightmap"))
    for uvl in [u for u in ob.data.uv_layers if u.name != "Lightmap"]:
        ob.data.uv_layers.remove(uvl)
RADIANCE.clear()

# Matériaux d'export des objets non bakés
OBJ["Dalles_LED"].data.materials.clear()
OBJ["Dalles_LED"].data.materials.append(unlit_mat("Dalle_LED", None, color=(1.0, 0.98, 0.95)))
M_FACADE.use_backface_culling = True

# =========================================================================
# Rendus de contrôle depuis le point de vue fixe
# =========================================================================
sc.view_settings.view_transform = "Standard"     # textures déjà tonemappées
sc.view_settings.look = "None"
sc.view_settings.exposure = 0.0
sc.cycles.samples = 8 if DRAFT else 96
sc.render.resolution_x, sc.render.resolution_y = (640, 400) if DRAFT else (1280, 800)
cam_data = bpy.data.cameras.new("Controle")
cam_data.lens_unit = "FOV"
cam_data.angle = math.radians(84)
cam = bpy.data.objects.new("Controle", cam_data)
sc.collection.objects.link(cam)
sc.camera = cam
cam.location = EYE
for label, yaw in (("nord", 0), ("est", -90), ("sud", 180), ("ouest", 90), ("nord_est", -45)):
    cam.rotation_euler = (math.radians(88), 0, math.radians(yaw))
    sc.render.filepath = os.path.join(OUT, f"vue_{label}.png")
    bpy.ops.render.render(write_still=True)
log("rendus de contrôle OK")

# =========================================================================
# Export GLB (sans caméra ni lumière)
# =========================================================================
for ob in list(sc.objects):
    if ob.type != "MESH":
        bpy.data.objects.remove(ob, do_unlink=True)
bpy.ops.export_scene.gltf(
    filepath=GLB, export_format="GLB", export_yup=True, export_apply=True,
    export_image_format="AUTO", export_lights=False, export_cameras=False,
    use_selection=False,
)
log(f"GLB : {GLB} ({os.path.getsize(GLB) / 1e6:.1f} Mo)")
