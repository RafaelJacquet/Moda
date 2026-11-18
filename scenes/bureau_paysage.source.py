# French Flair — Paysage extérieur de la scène « bureau ».
# Rendu en panorama équirectangulaire 360° depuis le point de vue fixe
# (centre de la pièce, hauteur des yeux), puis flouté. L'image est ensuite
# projetée sur des plans placés derrière chaque fenêtre (cf. bureau.source.py).
#
# Lancement :  blender -b --python bureau_paysage.source.py -- <dossier_sortie>
# Repère : X = est, Y = nord, Z = haut. Le bureau est au 2e étage : sol du
# bureau en z = 0, rue en z = -7.

import bpy, bmesh, math, random, sys, os
import numpy as np
from mathutils import Vector, noise

OUT = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "/output"
EYE = Vector((0.0, 0.0, 1.6))   # point de vue fixe (doit correspondre au bureau)
GROUND = -7.0
RES = int(os.environ.get("PANO_RES", "4096"))                      # largeur du panorama (hauteur = RES/2)
SAMPLES = int(os.environ.get("PANO_SAMPLES", "48"))
BLUR_DEG = 0.9                   # flou (écart-type, en degrés)
SUN_ELEV, SUN_AZIM = 34.0, 112.0  # soleil : est-sud-est (azimut depuis le nord, sens horaire)

random.seed(7)
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
col = sc.collection

# ---------------------------------------------------------------- matériaux
def mat(name, rgb, rough=0.8, metal=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*rgb, 1)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    return m

def noisy_mat(name, c1, c2, scale, rough=0.9, kind="noise"):
    """Couleur variant entre c1 et c2 selon un bruit (coordonnées objet/monde)."""
    m = mat(name, c1, rough)
    nt = m.node_tree
    p = nt.nodes["Principled BSDF"]
    tc = nt.nodes.new("ShaderNodeTexCoord")
    if kind == "voronoi":
        tx = nt.nodes.new("ShaderNodeTexVoronoi")
        tx.inputs["Scale"].default_value = scale
        out = tx.outputs["Distance"] if False else tx.outputs["Color"]
    else:
        tx = nt.nodes.new("ShaderNodeTexNoise")
        tx.inputs["Scale"].default_value = scale
        tx.inputs["Detail"].default_value = 6
        out = tx.outputs["Fac"]
    nt.links.new(tc.outputs["Object"], tx.inputs["Vector"])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = (*c1, 1)
    ramp.color_ramp.elements[1].color = (*c2, 1)
    if kind == "voronoi":
        bw = nt.nodes.new("ShaderNodeRGBToBW")
        nt.links.new(out, bw.inputs[0])
        nt.links.new(bw.outputs[0], ramp.inputs[0])
    else:
        ramp.color_ramp.elements[0].position = 0.35
        ramp.color_ramp.elements[1].position = 0.65
        nt.links.new(out, ramp.inputs[0])
    nt.links.new(ramp.outputs[0], p.inputs["Base Color"])
    return m

def facade_mat(name, wall, win, floors_per_m=1 / 3.1, cols_per_m=1 / 2.6):
    """Façade : grille de fenêtres via une texture brique (coordonnées objet)."""
    m = mat(name, wall, 0.85)
    nt = m.node_tree
    p = nt.nodes["Principled BSDF"]
    tc = nt.nodes.new("ShaderNodeTexCoord")
    br = nt.nodes.new("ShaderNodeTexBrick")
    br.offset = 0.0
    br.squash = 1.0
    br.inputs["Color1"].default_value = (*win, 1)
    br.inputs["Color2"].default_value = (*win, 1)
    br.inputs["Mortar"].default_value = (*wall, 1)
    br.inputs["Scale"].default_value = 1.0
    br.inputs["Mortar Size"].default_value = 0.75
    br.inputs["Brick Width"].default_value = 1 / cols_per_m
    br.inputs["Row Height"].default_value = 1 / floors_per_m
    # Les façades sont dans les plans XZ / YZ : on projette (x+y, z)
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    comb = nt.nodes.new("ShaderNodeCombineXYZ")
    add = nt.nodes.new("ShaderNodeMath")
    nt.links.new(tc.outputs["Object"], sep.inputs[0])
    nt.links.new(sep.outputs[0], add.inputs[0])
    nt.links.new(sep.outputs[1], add.inputs[1])
    nt.links.new(add.outputs[0], comb.inputs[0])
    nt.links.new(sep.outputs[2], comb.inputs[1])
    nt.links.new(comb.outputs[0], br.inputs["Vector"])
    nt.links.new(br.outputs["Color"], p.inputs["Base Color"])
    return m

M_GRASS = noisy_mat("Herbe", (0.10, 0.20, 0.05), (0.20, 0.30, 0.08), 0.08)
M_FIELDS = noisy_mat("Champs", (0.20, 0.28, 0.08), (0.45, 0.40, 0.18), 0.012, kind="voronoi")
M_ROAD = noisy_mat("Bitume", (0.05, 0.05, 0.055), (0.09, 0.09, 0.09), 0.5, 0.9)
M_WALK = noisy_mat("Trottoir", (0.40, 0.38, 0.35), (0.50, 0.48, 0.44), 0.8)
M_LINE = mat("Marquage", (0.8, 0.8, 0.78), 0.6)
M_TRUNK = mat("Tronc", (0.10, 0.08, 0.06))
M_LEAF = [noisy_mat(f"Feuillage_{i}", c1, c2, 1.6) for i, (c1, c2) in enumerate([
    ((0.025, 0.05, 0.015), (0.07, 0.12, 0.03)),
    ((0.03, 0.06, 0.02), (0.09, 0.13, 0.04)),
    ((0.05, 0.07, 0.02), (0.13, 0.14, 0.05)),
    ((0.02, 0.045, 0.02), (0.05, 0.09, 0.035)),
])]
M_FAC = [
    facade_mat("Facade_Creme", (0.62, 0.55, 0.43), (0.08, 0.09, 0.11)),
    facade_mat("Facade_Blanche", (0.66, 0.64, 0.60), (0.10, 0.12, 0.14)),
    facade_mat("Facade_Brique", (0.45, 0.22, 0.14), (0.07, 0.08, 0.10)),
    facade_mat("Facade_Grise", (0.55, 0.55, 0.54), (0.12, 0.14, 0.17)),
]
M_ROOF = [mat("Toit_Zinc", (0.25, 0.27, 0.30), 0.5, 0.3), mat("Toit_Tuile", (0.38, 0.15, 0.08)),
          mat("Toit_Ardoise", (0.12, 0.13, 0.15), 0.6)]
M_CAR = [mat(f"Voiture_{i}", c, 0.25, 0.5) for i, c in enumerate(
    [(0.6, 0.6, 0.62), (0.05, 0.05, 0.06), (0.5, 0.05, 0.04), (0.08, 0.15, 0.35), (0.85, 0.85, 0.85)])]
M_GLASS_CAR = mat("Vitre_Voiture", (0.02, 0.03, 0.04), 0.1)

# ---------------------------------------------------------------- utilitaires
def link(name, bm, material):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me); bm.free()
    if isinstance(material, list):
        for mm in material:
            me.materials.append(mm)
    else:
        me.materials.append(material)
    ob = bpy.data.objects.new(name, me)
    col.objects.link(ob)
    return ob

def box(bm, x0, x1, y0, y1, z0, z1, mi=0):
    vs = [bm.verts.new((x, y, z)) for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)]
    for f in [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]:
        face = bm.faces.new([vs[i] for i in f])
        face.material_index = mi

def smoothstep(a, b, x):
    t = min(max((x - a) / (b - a), 0.0), 1.0)
    return t * t * (3 - 2 * t)

def terrain_h(x, y):
    d = math.hypot(x, y)
    hills = noise.noise(Vector((x / 700, y / 700, 0.3))) * 0.5 + 0.5
    ridge = noise.noise(Vector((x / 260, y / 260, 2.1)))
    return GROUND + smoothstep(200, 800, d) * (hills * 130 + ridge * 40) + smoothstep(60, 200, d) * ridge * 3

# ---------------------------------------------------------------- terrain
# Grille plus fine près du bâtiment : coordonnées non uniformes
def axis_samples():
    pts = []
    x = 0.0
    while x < 2400:
        pts.append(x)
        x += 4 if x < 120 else (12 if x < 500 else 40)
    return sorted(set([-p for p in pts] + pts))

ax = axis_samples()
bm = bmesh.new()
grid = [[bm.verts.new((x, y, terrain_h(x, y))) for x in ax] for y in ax]
for j in range(len(ax) - 1):
    for i in range(len(ax) - 1):
        f = bm.faces.new((grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]))
        cx, cy = (ax[i] + ax[i + 1]) / 2, (ax[j] + ax[j + 1]) / 2
        f.material_index = 1 if math.hypot(cx, cy) > 260 else 0
        f.smooth = True
link("Terrain", bm, [M_GRASS, M_FIELDS])

# ---------------------------------------------------------------- rues
z = GROUND + 0.02
bm = bmesh.new()
box(bm, -600, 600, 12, 20, z - 0.1, z, 0)       # rue nord (est-ouest)
box(bm, 14, 22, -600, 12, z - 0.1, z, 0)        # rue est (nord-sud)
link("Rues", bm, M_ROAD)
bm = bmesh.new()
for y0, y1 in ((6, 12), (20, 25)):
    box(bm, -600, 600, y0, y1, z - 0.1, z + 0.15)
for x0, x1 in ((8, 14), (22, 27)):
    box(bm, x0, x1, -600, 12, z - 0.1, z + 0.15)
link("Trottoirs", bm, M_WALK)
bm = bmesh.new()
for x in range(-600, 600, 9):
    box(bm, x, x + 4.5, 15.9, 16.1, z, z + 0.005)
for y in range(-600, 12, 9):
    box(bm, 17.9, 18.1, y, y + 4.5, z, z + 0.005)
link("Marquages", bm, M_LINE)

# Pied de l'immeuble du bureau (vu en plongée depuis la fenêtre)
M_BASE = mat("Immeuble_Bureau", (0.70, 0.68, 0.64), 0.85)
bm = bmesh.new()
box(bm, -40, 3.2, -40, 2.7, GROUND, -0.15)   # façade alignée sur les murs du bureau
link("Immeuble_Bureau_Socle", bm, M_BASE)

# ---------------------------------------------------------------- arbres
def make_tree_proto(name, mi, kind):
    bm = bmesh.new()
    if kind == "cone":
        bmesh.ops.create_cone(bm, cap_ends=True, segments=10, radius1=1.0, radius2=0.0, depth=2.6,
                              matrix=__import__("mathutils").Matrix.Translation((0, 0, 1.6)))
    else:
        bmesh.ops.create_icosphere(bm, subdivisions=4, radius=1.0,
                                   matrix=__import__("mathutils").Matrix.Translation((0, 0, 1.0)))
        for v in bm.verts:   # silhouette irrégulière (grosses touffes + détail)
            o = Vector((mi * 3.1, 0, 0))
            n = noise.noise(v.co * 1.3 + o) * 0.32 + noise.noise(v.co * 4.0 + o) * 0.12
            v.co *= 1.0 + n
    for f in bm.faces:
        f.material_index = 1
        f.smooth = True
    # tronc
    bmesh.ops.create_cone(bm, cap_ends=True, segments=6, radius1=0.09, radius2=0.06, depth=0.8,
                          matrix=__import__("mathutils").Matrix.Translation((0, 0, -0.2)))
    for f in bm.faces:
        if f.material_index != 1:
            f.material_index = 0
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me); bm.free()
    me.materials.append(M_TRUNK)
    me.materials.append(M_LEAF[mi % len(M_LEAF)])
    return me

PROTOS = [make_tree_proto(f"ArbreProto_{i}", i, "sphere") for i in range(4)] + \
         [make_tree_proto(f"ConiferProto_{i}", i, "cone") for i in range(2)]

def tree(x, y, size, proto=None, zbase=None):
    me = proto or random.choice(PROTOS[:4])
    ob = bpy.data.objects.new("Arbre", me)
    zb = terrain_h(x, y) if zbase is None else zbase
    # proto : couronne de rayon 1 centrée à z=1 ; tronc ~ jusqu'à z=0
    trunk = size * 0.9
    ob.location = (x, y, zb + trunk)
    s = size * random.uniform(0.85, 1.15)
    ob.scale = (s, s, s * random.uniform(0.9, 1.25))
    ob.rotation_euler = (0, 0, random.uniform(0, 6.28))
    col.objects.link(ob)

def free_spot(x, y):
    """Pas d'arbre sur les rues / l'immeuble."""
    if 4 < y < 27 and abs(x) < 600:
        return False
    if 6 < x < 29 and y < 27:
        return False
    if x < 10 and y < 8 and x > -42 and y > -42:
        return False
    return True

# alignements de platanes
for x in range(-300, 300, 11):
    for y in (23.0,) if abs(x) < 25 else (8.5, 23.0):
        if not (6 < x < 29):
            tree(x + random.uniform(-1, 1), y, random.uniform(2.6, 3.4), zbase=GROUND)
for y in range(-300, 6, 11):
    for x in (25.0,) if abs(y) < 25 else (10.5, 25.0):
        tree(x, y + random.uniform(-1, 1), random.uniform(2.6, 3.4), zbase=GROUND)

# parc au nord (au-delà de la rue)
for _ in range(160):
    x, y = random.uniform(-160, 120), random.uniform(30, 140)
    tree(x, y, random.uniform(2.2, 4.5))
# bosquets épars à l'est / nord-est
for _ in range(220):
    a = math.radians(random.uniform(-40, 140))   # depuis +X vers +Y
    d = random.uniform(60, 420)
    x, y = 30 + d * math.cos(a), d * math.sin(a)
    if free_spot(x, y):
        tree(x, y, random.uniform(2.5, 6.0))
# forêts sur les collines lointaines
for _ in range(1400):
    a = random.uniform(0, 2 * math.pi)
    d = random.uniform(500, 1800)
    x, y = d * math.cos(a), d * math.sin(a)
    if noise.noise(Vector((x / 300, y / 300, 5.0))) > -0.05:
        tree(x, y, random.uniform(5, 9), proto=random.choice(PROTOS))

# ---------------------------------------------------------------- immeubles
def building(x, y, w, d, h, roof_kind=None):
    zb = min(terrain_h(x, y), terrain_h(x + w, y + d)) - 0.5
    bm = bmesh.new()
    box(bm, x, x + w, y, y + d, zb, zb + h, 0)
    ob = link("Immeuble", bm, random.choice(M_FAC))
    # toit : mansarde (tronc de pyramide)
    rk = roof_kind if roof_kind is not None else random.randrange(len(M_ROOF))
    bm = bmesh.new()
    ins = min(w, d) * 0.22
    rh = random.uniform(2.5, 4.5)
    zt = zb + h
    bot = [bm.verts.new(p) for p in ((x, y, zt), (x + w, y, zt), (x + w, y + d, zt), (x, y + d, zt))]
    top = [bm.verts.new(p) for p in ((x + ins, y + ins, zt + rh), (x + w - ins, y + ins, zt + rh),
                                     (x + w - ins, y + d - ins, zt + rh), (x + ins, y + d - ins, zt + rh))]
    for i in range(4):
        bm.faces.new((bot[i], bot[(i + 1) % 4], top[(i + 1) % 4], top[i]))
    bm.faces.new(top)
    link("Toit", bm, M_ROOF[rk])

# îlot haussmannien à l'est (de l'autre côté de la rue est)
for i in range(6):
    y0 = -70 + i * 17
    building(30, y0, random.uniform(14, 20), 15.5, random.uniform(15, 19), 0)
# immeubles derrière le parc au nord et au nord-est
for _ in range(26):
    x = random.uniform(-220, 260)
    y = random.uniform(160, 320)
    building(x, y, random.uniform(12, 30), random.uniform(10, 18), random.uniform(9, 24))
for _ in range(20):
    a = math.radians(random.uniform(-30, 60))
    d = random.uniform(110, 330)
    x, y = 30 + d * math.cos(a), d * math.sin(a)
    if free_spot(x, y):
        building(x, y, random.uniform(10, 22), random.uniform(10, 16), random.uniform(7, 18))
# pavillons lointains
for _ in range(60):
    a = random.uniform(0, 2 * math.pi)
    d = random.uniform(350, 900)
    x, y = d * math.cos(a), d * math.sin(a)
    building(x, y, random.uniform(8, 12), random.uniform(7, 10), random.uniform(4, 6), 1)

# ---------------------------------------------------------------- voitures garées
def car(x, y, along_x):
    bm = bmesh.new()
    L, W = random.uniform(3.9, 4.6), 1.8
    if along_x:
        box(bm, x, x + L, y, y + W, GROUND + 0.25, GROUND + 0.95, 0)
        box(bm, x + 0.8, x + L - 1.0, y + 0.1, y + W - 0.1, GROUND + 0.95, GROUND + 1.45, 1)
    else:
        box(bm, x, x + W, y, y + L, GROUND + 0.25, GROUND + 0.95, 0)
        box(bm, x + 0.1, x + W - 0.1, y + 0.8, y + L - 1.0, GROUND + 0.95, GROUND + 1.45, 1)
    link("Voiture", bm, [random.choice(M_CAR), M_GLASS_CAR])

for x in range(-80, 6, 6):
    if random.random() < 0.7:
        car(x + random.uniform(0, 1), 12.3, True)
for x in range(30, 120, 6):
    if random.random() < 0.6:
        car(x, 17.9, True)
for y in range(-80, 8, 6):
    if random.random() < 0.7:
        car(14.3, y + random.uniform(0, 1), False)

# ---------------------------------------------------------------- ciel
world = bpy.data.worlds.new("Ciel")
sc.world = world
world.use_nodes = True
nt = world.node_tree
bg = nt.nodes["Background"]
sky = nt.nodes.new("ShaderNodeTexSky")
sky.sky_type = "NISHITA"
sky.sun_disc = True
sky.sun_elevation = math.radians(SUN_ELEV)
# Nishita : rotation 0 = soleil vers +Y, sens horaire = azimut géographique
sky.sun_rotation = math.radians(SUN_AZIM)
sky.altitude = 30
sky.air_density = 1.0
sky.dust_density = 1.2
sky.ozone_density = 1.0
nt.links.new(sky.outputs[0], bg.inputs[0])
bg.inputs[1].default_value = 1.0

# ---------------------------------------------------------------- rendu panorama
cam_data = bpy.data.cameras.new("Pano")
cam_data.type = "PANO"
cam_data.panorama_type = "EQUIRECTANGULAR"
cam = bpy.data.objects.new("Pano", cam_data)
col.objects.link(cam)
cam.location = EYE
cam.rotation_euler = (math.radians(90), 0, math.radians(-90))  # +X au centre de l'image
sc.camera = cam
cam_data.clip_end = 5000

sc.render.engine = "CYCLES"
sc.cycles.device = "CPU"
sc.cycles.samples = SAMPLES
sc.cycles.use_denoising = False
sc.cycles.max_bounces = 4
sc.render.resolution_x = RES
sc.render.resolution_y = RES // 2
sc.render.resolution_percentage = 100
sc.view_settings.view_transform = "Filmic"
sc.view_settings.look = "Medium Contrast" if "Medium Contrast" in [
    i.identifier for i in sc.view_settings.bl_rna.properties["look"].enum_items] else "None"
sc.view_settings.exposure = float(os.environ.get("PANO_EXPOSURE", "-2.4"))

# Perspective aérienne : passe "mist" mélangée à une teinte de brume
vl = sc.view_layers[0]
vl.use_pass_mist = True
world.mist_settings.start = 40
world.mist_settings.depth = 2200
world.mist_settings.falloff = "QUADRATIC"
sc.use_nodes = True
ct = sc.node_tree
ct.nodes.clear()
rl = ct.nodes.new("CompositorNodeRLayers")
mix = ct.nodes.new("CompositorNodeMixRGB")
mix.blend_type = "MIX"
mix.inputs[2].default_value = (0.70, 0.76, 0.84, 1)
mul = ct.nodes.new("CompositorNodeMath")
mul.operation = "MULTIPLY"
mul.inputs[1].default_value = 0.45
ct.links.new(rl.outputs["Mist"], mul.inputs[0])
ct.links.new(mul.outputs[0], mix.inputs[0])
ct.links.new(rl.outputs["Image"], mix.inputs[1])
comp = ct.nodes.new("CompositorNodeComposite")
ct.links.new(mix.outputs[0], comp.inputs[0])

os.makedirs(OUT, exist_ok=True)
raw = os.path.join(OUT, "paysage_net.png")
sc.render.filepath = raw
sc.render.image_settings.file_format = "PNG"
bpy.ops.render.render(write_still=True)
print("panorama net :", raw)

# ---------------------------------------------------------------- flou
img = bpy.data.images.load(raw)
W, H = img.size
a = np.array(img.pixels[:], dtype=np.float32).reshape(H, W, 4)[:, :, :3]

def gauss_blur(a, sigma_px, axis, wrap):
    r = int(sigma_px * 3) + 1
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma_px) ** 2)
    k /= k.sum()
    pad = [(0, 0)] * a.ndim
    pad[axis] = (r, r)
    p = np.pad(a, pad, mode="wrap" if wrap else "edge")
    out = np.zeros_like(a)
    n = a.shape[axis]
    for i, w in enumerate(k):
        sl = [slice(None)] * a.ndim
        sl[axis] = slice(i, i + n)
        out += w * p[tuple(sl)]
    return out

sigma = BLUR_DEG / 360.0 * W
b = gauss_blur(a, sigma, 1, True)
b = gauss_blur(b, sigma, 0, False)
out = np.dstack([b, np.ones((H, W), np.float32)])
blur = bpy.data.images.new("paysage_flou", W, H, alpha=False)
blur.pixels.foreach_set(out.ravel())
blur.filepath_raw = os.path.join(OUT, "paysage_flou.jpg")
blur.file_format = "JPEG"
sc.render.image_settings.quality = 90
blur.save()
print("panorama flou :", blur.filepath_raw)
