'use strict';
// 3D aquarium viewer powered by Three.js.
// Exposes window.Tank3D. Requires three.min.js to be loaded first.

(function () {
  if (typeof THREE === 'undefined') {
    console.warn('tank3d: Three.js not loaded');
    return;
  }

  const TANK_W = 8, TANK_H = 4.8, TANK_D = 4;
  const CENTER_X = TANK_W / 2, CENTER_Y = TANK_H * 0.42, CENTER_Z = TANK_D / 2;

  function lerpHex(a, b, t) {
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
    const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
    return (Math.round(ar + (br - ar) * t) << 16) |
           (Math.round(ag + (bg - ag) * t) << 8) |
            Math.round(ab + (bb - ab) * t);
  }

  // Map 2D snapshot coordinates to 3D scene units.
  // 2D: x 0..800, y 0..480 (down), z 0..0.75 (front→back)
  // 3D: x 0..8,   y 0..4.8 (up),   z 0..4   (front→back)
  function mapPos(x, y, z) {
    return new THREE.Vector3(
      (x / 800) * TANK_W,
      ((480 - y) / 480) * TANK_H,
      ((z || 0) / 0.75) * TANK_D
    );
  }

  // Mirrors seaweedBranches() in app.js — deterministic branch nodes from plant x.
  function seaweedBranches3d(x, segs) {
    const n = 1 + (x % 2);
    const out = [];
    for (let b = 0; b < n; b++) {
      const at = 2 + (((x >> (b * 3)) >>> 0) % Math.max(1, segs - 2));
      out.push({ at, side: ((x >> b) & 1) ? 1 : -1 });
    }
    return out;
  }

  class Tank3D {
    constructor(canvas) {
      this._canvas = canvas;
      this._scene = new THREE.Scene();
      this._camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
      this._renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      this._renderer.setClearColor(0x001122, 1);

      this._fishMeshes = new Map();
      this._fishGroup = new THREE.Group();
      this._plantGroup = null;
      this._plantKey   = null;

      this._snailDecorMesh  = null;          // snap.snail (decorative pond snail)
      this._snailCollectors = new Map();     // snap.snails (career coin-collector snails)
      this._starfishMesh    = null;          // snap.starfish

      this._decorGroups  = new Map();        // decoration id → THREE.Group
      this._placingKind  = null;             // 'castle' | null — placement mode
      this._ghostGroup   = null;             // semi-transparent preview during placement
      this._dragMoved    = false;            // distinguishes click from drag
      this.onPlace       = null;             // callback(kind, x2d, z2d) set by app.js

      // Orbit: theta = horizontal angle, phi = elevation (radians from top).
      // theta=PI puts the camera in front of the tank (negative z offset from centre).
      this._orbit = {
        theta: Math.PI,
        phi: 0.62,
        r: 12,
        dragging: false,
        lx: 0, ly: 0,
        downX: 0, downY: 0,
      };

      this._buildScene();
      this._setupMouse();
      this._resize();
      window.addEventListener('resize', () => this._resize());
      this._animate();
    }

    _resize() {
      const w = this._canvas.clientWidth  || 800;
      const h = this._canvas.clientHeight || 300;
      this._renderer.setPixelRatio(window.devicePixelRatio || 1);
      this._renderer.setSize(w, h, false); // false = don't override CSS size
      this._camera.aspect = w / h;
      this._camera.updateProjectionMatrix();
      this._updateCamera();
    }

    _buildScene() {
      const s = this._scene;

      // Lighting
      s.add(new THREE.AmbientLight(0x334466, 1.4));
      const sun = new THREE.DirectionalLight(0xffffff, 1.1);
      sun.position.set(5, 10, 6);
      s.add(sun);
      const fill = new THREE.DirectionalLight(0x4488cc, 0.4);
      fill.position.set(-3, 1, -2);
      s.add(fill);

      // Glass tank walls — BackSide so we see the inside surface.
      // Position at tank centre so it aligns with the water, sand, and fish.
      const tankCenter = new THREE.Vector3(TANK_W / 2, TANK_H / 2, TANK_D / 2);
      const boxGeo = new THREE.BoxGeometry(TANK_W, TANK_H, TANK_D);

      const glassMesh = new THREE.Mesh(boxGeo, new THREE.MeshPhysicalMaterial({
        color: 0x88bbdd,
        transparent: true,
        opacity: 0.06,
        side: THREE.BackSide,
        roughness: 0,
        metalness: 0.1,
      }));
      glassMesh.position.copy(tankCenter);
      s.add(glassMesh);

      // Tank glass edges
      const edgeMesh = new THREE.LineSegments(
        new THREE.EdgesGeometry(boxGeo),
        new THREE.LineBasicMaterial({ color: 0x6699bb, transparent: true, opacity: 0.65 })
      );
      edgeMesh.position.copy(tankCenter);
      s.add(edgeMesh);

      // Rim — black aluminium frame around the top and bottom of the tank,
      // with four vertical corner posts joining them.
      this._addRim(s);

      // Sand floor with the same three-sine terrain bumps used by the 2D renderer
      const sandGeo = new THREE.PlaneGeometry(TANK_W, TANK_D, 160, 60);
      const pos = sandGeo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const xPx = (pos.getX(i) / TANK_W + 0.5) * 800;
        const bump = (
          Math.sin(xPx * 0.018) * 4 +
          Math.sin(xPx * 0.063) * 2.5 +
          Math.sin(xPx * 0.14)  * 1.5
        ) / 100;
        pos.setZ(i, bump);
      }
      sandGeo.computeVertexNormals();
      const sandMesh = new THREE.Mesh(
        sandGeo,
        new THREE.MeshLambertMaterial({ color: 0xC8A050 })
      );
      sandMesh.rotation.x = -Math.PI / 2;
      sandMesh.position.set(TANK_W / 2, 0, TANK_D / 2);
      s.add(sandMesh);

      // Water volume — transparent blue fill inside the tank
      const waterMesh = new THREE.Mesh(
        new THREE.BoxGeometry(TANK_W - 0.05, TANK_H - 0.05, TANK_D - 0.05),
        new THREE.MeshPhysicalMaterial({
          color: 0x002244,
          transparent: true,
          opacity: 0.20,
          roughness: 0.05,
          side: THREE.FrontSide,
        })
      );
      waterMesh.position.set(TANK_W / 2, TANK_H / 2, TANK_D / 2);
      s.add(waterMesh);

      s.add(this._fishGroup);
    }

    _makeSnailGroup(collector) {
      const BODY_COL  = collector ? 0x8FD89A : 0xDDB060;
      const SHELL_COL = collector ? 0x1F6B47 : 0x7A2E0A;
      const SWIRL_COL = collector ? 0x5FE0A0 : 0xB05020;
      const mBody  = new THREE.MeshLambertMaterial({ color: BODY_COL });
      const mShell = new THREE.MeshLambertMaterial({ color: SHELL_COL });
      const mSwirl = new THREE.MeshLambertMaterial({ color: SWIRL_COL });
      const mEye   = new THREE.MeshLambertMaterial({ color: 0x111111 });
      const g = new THREE.Group();

      // Shell — large sphere offset to the rear
      const shell = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), mShell);
      shell.scale.set(1.0, 0.95, 0.8);
      shell.position.set(-0.08, 0.13, 0);
      g.add(shell);

      // Swirl — smaller tinted sphere overlaid on the shell
      const swirl = new THREE.Mesh(new THREE.SphereGeometry(0.08, 6, 5), mSwirl);
      swirl.scale.set(0.9, 0.8, 0.7);
      swirl.position.set(-0.06, 0.13, 0.03);
      g.add(swirl);

      // Body — flat ellipsoid lying on the sand
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 5), mBody);
      body.scale.set(1.6, 0.4, 0.65);
      body.position.set(0, 0.048, 0);
      g.add(body);

      // Head
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), mBody);
      head.position.set(0.19, 0.10, 0);
      g.add(head);

      // Two eyestalks + pupils — mirroring the 2D eyestalk pairs
      for (const [zOff, xOff] of [[-0.04, 0.14], [0.04, 0.20]]) {
        const stalk = new THREE.Mesh(
          new THREE.CylinderGeometry(0.012, 0.012, 0.10, 4), mBody);
        stalk.position.set(xOff, 0.20, zOff);
        g.add(stalk);
        const eyeball = new THREE.Mesh(new THREE.SphereGeometry(0.030, 5, 4), mBody);
        eyeball.position.set(xOff, 0.26, zOff);
        g.add(eyeball);
        const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.018, 4, 4), mEye);
        pupil.position.set(xOff + 0.012, 0.262, zOff);
        g.add(pupil);
      }

      return g;
    }

    _makeStarfishGroup() {
      const mat = new THREE.MeshLambertMaterial({ color: 0xFF6600 });
      const g = new THREE.Group();

      // 5 arms as elongated spheres radiating from centre
      const ARM_R = 0.24;
      for (let i = 0; i < 5; i++) {
        const angle = (i / 5) * Math.PI * 2;
        const arm = new THREE.Mesh(new THREE.SphereGeometry(0.10, 7, 5), mat);
        arm.scale.set(2.2, 0.28, 0.55);
        arm.rotation.y = -angle;
        arm.position.set(Math.cos(angle) * ARM_R, 0, Math.sin(angle) * ARM_R);
        g.add(arm);
      }

      // Central disk
      const centre = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 5), mat);
      centre.scale.set(1, 0.3, 1);
      g.add(centre);

      return g;
    }

    // Build 3D plant meshes from snapshot plant data.
    // Each type maps to its 2D z-layer: bg=back, weeds=mid, hornwort=front.
    _buildPlants(plants) {
      if (this._plantGroup) {
        this._scene.remove(this._plantGroup);
        this._plantGroup = null;
      }
      if (!plants) return;

      const g = new THREE.Group();
      this._plantGroup = g;
      this._scene.add(g);

      // One segment height in 3D units, matching the 2D 15px / 14px per segment.
      const SEG15 = (15 / 480) * TANK_H;
      const SEG14 = (14 / 480) * TANK_H;

      // Shared materials — one per colour so GPU batches them.
      const mSD = new THREE.MeshLambertMaterial({ color: 0x0D3318 }); // bg stem dark
      const mLD = new THREE.MeshLambertMaterial({ color: 0x163D20 }); // bg leaf dark
      const mSG = new THREE.MeshLambertMaterial({ color: 0x00AA44 }); // green stem
      const mLG = new THREE.MeshLambertMaterial({ color: 0x33DD66 }); // green leaf

      // Shared leaf geometries (scale is set per-mesh, not per-geometry).
      const gLeafD = new THREE.SphereGeometry(0.11, 6, 4);
      const gLeafG = new THREE.SphereGeometry(0.10, 6, 4);

      const add = (mesh) => g.add(mesh);

      // ── bg plants (z ≈ back wall) ─────────────────────────────────────────
      const Z_BG = TANK_D * 0.85;
      for (const p of (plants.bg || [])) {
        const segs = p.segs || 6;
        const x3 = (p.x / 800) * TANK_W;
        const h   = segs * SEG15;

        if ((p.type || 0) === 0) {
          // Type 0 — wavy stem + alternating elliptical leaves
          const stem = new THREE.Mesh(
            new THREE.CylinderGeometry(0.025, 0.04, h, 4), mSD);
          stem.position.set(x3, h / 2, Z_BG);
          add(stem);

          for (let s = 1; s < segs; s++) {
            const side = (s % 2 === 0) ? 1 : -1;
            const leaf = new THREE.Mesh(gLeafD, mLD);
            leaf.scale.set(1.3, 0.55, 0.45);
            leaf.position.set(x3 + side * 0.20, s * SEG15, Z_BG);
            add(leaf);
          }
        } else {
          // Type 1 — straight stem + horizontal needle pairs
          const stem = new THREE.Mesh(
            new THREE.CylinderGeometry(0.018, 0.03, h, 4), mSD);
          stem.position.set(x3, h / 2, Z_BG);
          add(stem);

          for (let s = 0; s <= segs; s++) {
            const nl = (1 - (s / segs) * 0.65) * 0.22;
            if (nl < 0.04) continue;
            const ly = s * SEG15;
            for (const side of [-1, 1]) {
              const n = new THREE.Mesh(
                new THREE.BoxGeometry(nl, 0.018, 0.03), mLD);
              n.position.set(x3 + side * (nl / 2 + 0.025), ly, Z_BG);
              add(n);
            }
          }
        }
      }

      // ── seaweed (z ≈ mid-back) ───────────────────────────────────────────
      const Z_WEED = TANK_D * 0.60;
      for (const w of (plants.weeds || [])) {
        const segs = w.segs || 6;
        const x3   = (w.x / 800) * TANK_W;
        const h    = segs * SEG14;

        const stem = new THREE.Mesh(
          new THREE.CylinderGeometry(0.025, 0.04, h, 4), mSG);
        stem.position.set(x3, h / 2, Z_WEED);
        add(stem);

        for (let s = 1; s < segs; s++) {
          const side = (s % 2 === 0) ? 1 : -1;
          const leaf = new THREE.Mesh(gLeafG, mLG);
          leaf.scale.set(1.4, 0.50, 0.42);
          leaf.position.set(x3 + side * 0.22, s * SEG14, Z_WEED);
          add(leaf);
        }

        // Branches — same deterministic placement as the 2D renderer
        for (const br of seaweedBranches3d(w.x, segs)) {
          if (br.at >= segs) continue;
          let bx = x3, by = br.at * SEG14;
          for (let s = 1; s <= 3; s++) {
            const nx = x3 + br.side * s * 0.13;
            const ny = by + s * 0.13;
            const brStem = new THREE.Mesh(
              new THREE.CylinderGeometry(0.014, 0.020, 0.14, 4), mSG);
            brStem.rotation.z = -br.side * Math.PI / 4;
            brStem.position.set((bx + nx) / 2, (by + ny) / 2, Z_WEED);
            add(brStem);
            const brLeaf = new THREE.Mesh(gLeafG, mLG);
            brLeaf.scale.set(1.1, 0.45, 0.40);
            brLeaf.position.set(nx, ny, Z_WEED);
            add(brLeaf);
            bx = nx; by = ny;
          }
        }
      }

      // ── hornwort (z ≈ front wall) ─────────────────────────────────────────
      const Z_HORN = TANK_D * 0.15;
      for (const h of (plants.hornwort || [])) {
        const segs   = h.segs || 5;
        const x3     = (h.x / 800) * TANK_W;
        const height = segs * SEG14;

        const stem = new THREE.Mesh(
          new THREE.CylinderGeometry(0.018, 0.03, height, 4), mSG);
        stem.position.set(x3, height / 2, Z_HORN);
        add(stem);

        for (let s = 0; s <= segs; s++) {
          const nl = (1 - (s / segs) * 0.60) * 0.28;
          if (nl < 0.04) continue;
          const ly = s * SEG14;
          for (const side of [-1, 1]) {
            const n = new THREE.Mesh(
              new THREE.BoxGeometry(nl, 0.016, 0.025), mLG);
            n.position.set(x3 + side * (nl / 2 + 0.018), ly, Z_HORN);
            add(n);
          }
        }
      }
    }

    _addRim(s) {
      const T = 0.14;   // bar thickness
      const H = 0.20;   // rim height
      const mat = new THREE.MeshLambertMaterial({ color: 0x3a3a3a });

      // Helper: add one rectangular bar centred at (x, y, z)
      const bar = (w, h, d, x, y, z) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
        m.position.set(x, y, z);
        s.add(m);
      };

      const W = TANK_W, D = TANK_D;

      // Top rim — four bars forming a rectangle at y = TANK_H
      const ty = TANK_H + H / 2;
      bar(W + T * 2, H, T, W / 2, ty, -T / 2);        // front
      bar(W + T * 2, H, T, W / 2, ty, D + T / 2);     // back
      bar(T, H, D + T * 2, -T / 2, ty, D / 2);        // left
      bar(T, H, D + T * 2, W + T / 2, ty, D / 2);     // right

      // Bottom rim — same layout at y = 0
      const by = -H / 2;
      bar(W + T * 2, H, T, W / 2, by, -T / 2);
      bar(W + T * 2, H, T, W / 2, by, D + T / 2);
      bar(T, H, D + T * 2, -T / 2, by, D / 2);
      bar(T, H, D + T * 2, W + T / 2, by, D / 2);

      // Vertical corner posts joining top and bottom rims
      const postH = TANK_H;
      const py = TANK_H / 2;
      bar(T, postH, T, -T / 2,     py, -T / 2);
      bar(T, postH, T, W + T / 2,  py, -T / 2);
      bar(T, postH, T, -T / 2,     py, D + T / 2);
      bar(T, postH, T, W + T / 2,  py, D + T / 2);
    }

    _setupMouse() {
      const c = this._canvas;
      const o = this._orbit;

      c.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        o.dragging = true;
        o.lx = o.downX = e.clientX;
        o.ly = o.downY = e.clientY;
        this._dragMoved = false;
        if (!this._placingKind) c.style.cursor = 'grabbing';
      });

      window.addEventListener('mousemove', (e) => {
        // Update ghost position whenever mouse is over the canvas during placement
        if (this._placingKind && this._ghostGroup && (e.target === c || o.dragging)) {
          this._updateGhostPos(e);
        }
        if (!o.dragging) return;
        const dx = e.clientX - o.lx;
        const dy = e.clientY - o.ly;
        const totalDx = e.clientX - o.downX;
        const totalDy = e.clientY - o.downY;
        if (Math.abs(totalDx) > 4 || Math.abs(totalDy) > 4) {
          this._dragMoved = true;
          o.theta -= dx * 0.005;
          o.phi = Math.max(0.05, Math.min(Math.PI * 0.47, o.phi - dy * 0.005));
          this._updateCamera();
        }
        o.lx = e.clientX;
        o.ly = e.clientY;
      });

      window.addEventListener('mouseup', (e) => {
        if (!o.dragging) return;
        o.dragging = false;
        // A mouseup without significant drag on the canvas = click
        if (!this._dragMoved && e.target === c && this._placingKind) {
          this._handlePlaceClick(e);
        }
        if (!this._placingKind) c.style.cursor = 'grab';
        this._dragMoved = false;
      });

      c.style.cursor = 'grab';
    }

    _handlePlaceClick(e) {
      if (!this._placingKind || !this.onPlace) return;
      const rect = this._canvas.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(mouse, this._camera);
      const sandPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      const hit = new THREE.Vector3();
      if (raycaster.ray.intersectPlane(sandPlane, hit)) {
        const x3 = Math.max(0.4, Math.min(TANK_W - 0.4, hit.x));
        const z3 = Math.max(0.4, Math.min(TANK_D - 0.4, hit.z));
        // Mirror x: front-facing camera has screen-right = world -x, so flip
        // so that right in 3D view == right in 2D canvas.
        const x2d = ((TANK_W - x3) / TANK_W) * 800;
        const z2d = (z3 / TANK_D) * 0.75;
        const kind = this._placingKind;
        this._placingKind = null;
        this._canvas.style.cursor = 'grab';
        if (this._ghostGroup) { this._scene.remove(this._ghostGroup); this._ghostGroup = null; }
        this.onPlace(kind, x2d, z2d);
      }
    }

    startPlacing(kind) {
      this._placingKind = kind;
      this._canvas.style.cursor = 'crosshair';
      if (this._ghostGroup) this._scene.remove(this._ghostGroup);
      this._ghostGroup = this._makeGhostGroup(kind);
      this._ghostGroup.visible = false;
      this._scene.add(this._ghostGroup);
    }

    cancelPlacing() {
      this._placingKind = null;
      this._canvas.style.cursor = 'grab';
      if (this._ghostGroup) { this._scene.remove(this._ghostGroup); this._ghostGroup = null; }
    }

    _makeGhostGroup(kind) {
      let grp;
      if      (kind === 'castle') grp = this._makeCastleGroup();
      else if (kind === 'chest')  grp = this._makeTreasureChestGroup();
      else if (kind === 'anchor') grp = this._makeAnchorGroup();
      else if (kind === 'ship')   grp = this._makeSunkenShipGroup();
      else grp = new THREE.Group();
      grp.traverse((obj) => {
        if (obj.isMesh) {
          obj.material = obj.material.clone();
          obj.material.transparent = true;
          obj.material.opacity = 0.45;
        }
      });
      return grp;
    }

    _updateGhostPos(e) {
      if (!this._ghostGroup) return;
      const rect = this._canvas.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(mouse, this._camera);
      const sandPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      const hit = new THREE.Vector3();
      if (raycaster.ray.intersectPlane(sandPlane, hit)) {
        const x3 = Math.max(0.4, Math.min(TANK_W - 0.4, hit.x));
        const z3 = Math.max(0.4, Math.min(TANK_D - 0.4, hit.z));
        this._ghostGroup.position.set(x3, 0, z3);
        this._ghostGroup.visible = true;
      } else {
        this._ghostGroup.visible = false;
      }
    }

    // Replace all decoration meshes to match the provided array.
    setDecorations(decorations) {
      for (const [, grp] of this._decorGroups) this._scene.remove(grp);
      this._decorGroups.clear();
      for (const d of decorations) {
        let grp;
        if      (d.type === 'castle') grp = this._makeCastleGroup();
        else if (d.type === 'chest')  grp = this._makeTreasureChestGroup();
        else if (d.type === 'anchor') grp = this._makeAnchorGroup();
        else if (d.type === 'ship')   grp = this._makeSunkenShipGroup();
        else continue;
        // Mirror x to match front-facing camera convention (screen-right = world -x).
      grp.position.set(TANK_W - (d.x / 800) * TANK_W, 0, ((d.z || 0) / 0.75) * TANK_D);
        this._scene.add(grp);
        this._decorGroups.set(d.id, grp);
      }
    }

    _makeFishGroup(color, fishType) {
      const g = new THREE.Group();
      const bodyMat = new THREE.MeshLambertMaterial({ color });
      const eyeMat  = new THREE.MeshLambertMaterial({ color: 0x050505 });
      g._bodyMat = bodyMat; // stored for colour updates

      const add = (geo, mat, px, py, pz, rx, ry, rz, sx, sy, sz) => {
        const m = new THREE.Mesh(geo, mat);
        if (px !== undefined) m.position.set(px, py, pz);
        if (rx !== undefined) m.rotation.set(rx, ry, rz);
        if (sx !== undefined) m.scale.set(sx, sy, sz);
        g.add(m);
        return m;
      };

      // Body — elongated ellipsoid pointing along +X (fish's facing direction)
      add(new THREE.SphereGeometry(0.18, 10, 7), bodyMat,
          0, 0, 0,  0, 0, 0,  1.80, 0.68, 0.85);

      // Tail fin — two triangular lobes fanning up and down from the back
      // rotation.z = 0.92: ConeGeometry (+Y tip) rotated ~53° past -X = backward-up
      add(new THREE.ConeGeometry(0.13, 0.26, 3), bodyMat,
          -0.33, 0, 0,  0, 0, 0.92,  1, 1, 0.22);
      // rotation.z = π − 0.92: mirror → backward-down
      add(new THREE.ConeGeometry(0.13, 0.26, 3), bodyMat,
          -0.33, 0, 0,  0, 0, Math.PI - 0.92,  1, 1, 0.22);

      // Dorsal fin — flat upright triangle on top of body
      add(new THREE.ConeGeometry(0.055, 0.18, 3), bodyMat,
          -0.02, 0.22, 0,  0, 0, 0,  1, 1, 0.24);

      // Pectoral fin — small angled fin on the side
      add(new THREE.ConeGeometry(0.045, 0.13, 3), bodyMat,
          0.08, -0.06, 0.12,  0.4, 0, -0.5,  1, 1, 0.35);

      // Eye — small dark sphere near the nose
      add(new THREE.SphereGeometry(0.030, 6, 4), eyeMat,
          0.24, 0.04, 0.12);

      return g;
    }

    _makeCastleGroup() {
      const mStone  = new THREE.MeshLambertMaterial({ color: 0x9a9a8a });
      const mDark   = new THREE.MeshLambertMaterial({ color: 0x6a6a5a });
      const mGate   = new THREE.MeshLambertMaterial({ color: 0x111106 });
      const g       = new THREE.Group();

      const box = (w, h, d, x, y, z, m) => {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m || mStone);
        mesh.position.set(x, y, z);
        g.add(mesh);
      };

      // Main keep
      const KH = 0.50, KW = 0.88, KD = 0.55;
      box(KW, KH, KD, 0, KH / 2, 0);

      // Keep battlements — alternating merlons along front and back top edges
      for (let i = -3; i <= 3; i++) {
        if (Math.abs(i) % 2 === 0) {
          box(0.10, 0.13, 0.08, i * 0.135, KH + 0.065, -KD / 2);
          box(0.10, 0.13, 0.08, i * 0.135, KH + 0.065,  KD / 2);
        }
      }

      // Gate (dark arch inset on front face)
      box(0.22, 0.28, 0.06, 0, 0.14, -KD / 2 - 0.01, mGate);

      // Left tower
      const TH = 0.78, TW = 0.28, TD = 0.30;
      const TLX = -(KW / 2 + TW / 2 - 0.02);
      box(TW, TH, TD, TLX, TH / 2, -0.06, mDark);
      // Corner battlements on left tower top (alternating)
      for (let ci = -1; ci <= 1; ci += 2) {
        for (let cj = -1; cj <= 1; cj += 2) {
          if ((ci + cj) % 2 === 0) continue;
          box(0.07, 0.11, 0.07,
            TLX + ci * (TW / 2 - 0.035),
            TH + 0.055,
            -0.06 + cj * (TD / 2 - 0.035), mStone);
        }
      }

      // Right tower (mirror of left)
      const TRX = KW / 2 + TW / 2 - 0.02;
      box(TW, TH, TD, TRX, TH / 2, -0.06, mDark);
      for (let ci = -1; ci <= 1; ci += 2) {
        for (let cj = -1; cj <= 1; cj += 2) {
          if ((ci + cj) % 2 === 0) continue;
          box(0.07, 0.11, 0.07,
            TRX + ci * (TW / 2 - 0.035),
            TH + 0.055,
            -0.06 + cj * (TD / 2 - 0.035), mStone);
        }
      }

      return g;
    }

    _makeTreasureChestGroup() {
      const mWood = new THREE.MeshLambertMaterial({ color: 0x7B3810 });
      const mDark = new THREE.MeshLambertMaterial({ color: 0x4A2008 });
      const mGold = new THREE.MeshLambertMaterial({ color: 0xC8941A });
      const mGlow = new THREE.MeshLambertMaterial({ color: 0xFFD700, emissive: new THREE.Color(0x553300) });
      const g = new THREE.Group();

      const box = (w, h, d, x, y, z, m) => {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m || mWood);
        mesh.position.set(x, y, z);
        g.add(mesh);
      };

      // Base body
      box(0.52, 0.28, 0.36, 0, 0.14, 0);
      // Gold bands
      box(0.54, 0.04, 0.38, 0, 0.07,  0, mGold);
      box(0.54, 0.04, 0.38, 0, 0.19,  0, mGold);
      // Corner metal strips
      for (const sx of [-1, 1]) {
        box(0.04, 0.30, 0.04, sx * 0.24, 0.14, -0.17, mGold);
        box(0.04, 0.30, 0.04, sx * 0.24, 0.14,  0.17, mGold);
      }
      // Lid (slightly open)
      const lid = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.09, 0.36), mDark);
      lid.rotation.x = -0.32;
      lid.position.set(0, 0.325, 0.042);
      g.add(lid);
      // Gold glow inside (treasure)
      box(0.26, 0.04, 0.16, 0, 0.30, -0.02, mGlow);
      // Lock hasp on front
      box(0.07, 0.07, 0.04, 0, 0.17, -0.19, mGold);

      return g;
    }

    _makeAnchorGroup() {
      const mat = new THREE.MeshLambertMaterial({ color: 0x383848 });
      const g = new THREE.Group();

      // Ring
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.024, 6, 16), mat);
      ring.position.set(0, 0.80, 0);
      g.add(ring);
      // Shank
      const shank = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.66, 6), mat);
      shank.position.set(0, 0.435, 0);
      g.add(shank);
      // Stock (crossbar near top)
      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.50, 0.042, 0.042), mat);
      stock.position.set(0, 0.72, 0);
      g.add(stock);
      // Crown at bottom of shank
      const crown = new THREE.Mesh(new THREE.SphereGeometry(0.038, 6, 4), mat);
      crown.position.set(0, 0.12, 0);
      g.add(crown);
      // Flukes — angle UP and OUT from crown (classic anchor silhouette)
      const flukeGeo = new THREE.BoxGeometry(0.22, 0.038, 0.08);
      const lf = new THREE.Mesh(flukeGeo, mat);
      lf.rotation.z = -0.50; // right end down (toward crown), left end up
      lf.position.set(-0.14, 0.24, 0);
      g.add(lf);
      const rf = new THREE.Mesh(flukeGeo, mat);
      rf.rotation.z = 0.50;  // left end down (toward crown), right end up
      rf.position.set(0.14, 0.24, 0);
      g.add(rf);
      // Fluke tips — up and out at the ends of the flukes
      const tipGeo = new THREE.SphereGeometry(0.052, 5, 4);
      const tl = new THREE.Mesh(tipGeo, mat); tl.position.set(-0.26, 0.33, 0); g.add(tl);
      const tr = new THREE.Mesh(tipGeo, mat); tr.position.set( 0.26, 0.33, 0); g.add(tr);

      // Lean slightly (resting at an angle on the sand)
      g.rotation.z = 0.28;

      return g;
    }

    _makeSunkenShipGroup() {
      const mHull  = new THREE.MeshLambertMaterial({ color: 0x3D2010 });
      const mPlank = new THREE.MeshLambertMaterial({ color: 0x2A1208 });
      const mCabin = new THREE.MeshLambertMaterial({ color: 0x5C3020 });
      const mPort  = new THREE.MeshLambertMaterial({ color: 0x0A1520 });
      const mMast  = new THREE.MeshLambertMaterial({ color: 0x6B4525 });
      const g = new THREE.Group();

      // Tilt hull slightly (sunk at an angle)
      g.rotation.z = 0.18;

      const box = (w, h, d, x, y, z, m) => {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m || mHull);
        mesh.position.set(x, y, z);
        g.add(mesh);
      };

      // Main hull
      box(1.40, 0.32, 0.58, 0, 0.16, 0);
      // Keel ridge
      box(1.28, 0.08, 0.32, 0, -0.01, 0, mPlank);
      // Plank stripes
      box(1.42, 0.05, 0.60, 0, 0.19, 0, mPlank);
      box(1.42, 0.05, 0.60, 0, 0.27, 0, mPlank);
      // Stern cabin
      box(0.50, 0.26, 0.46, -0.42, 0.45, 0, mCabin);
      // Portholes on cabin (front face)
      for (const pz of [-0.22, 0.22]) {
        const port = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.048, 0.05, 8), mPort);
        port.rotation.x = Math.PI / 2;
        port.position.set(-0.42, 0.45, pz);
        g.add(port);
      }
      // Bow (pointed front)
      const bowGeo = new THREE.ConeGeometry(0.17, 0.32, 4);
      const bow = new THREE.Mesh(bowGeo, mHull);
      bow.rotation.z = -Math.PI / 2;
      bow.position.set(0.81, 0.16, 0);
      g.add(bow);
      // Broken mast (fallen at steep angle)
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.033, 0.82, 6), mMast);
      mast.rotation.z = -1.05;
      mast.position.set(-0.08, 0.50, 0.04);
      g.add(mast);

      return g;
    }

    _updateCamera() {
      const { theta, phi, r } = this._orbit;
      this._camera.position.set(
        CENTER_X + r * Math.sin(phi) * Math.sin(theta),
        CENTER_Y + r * Math.cos(phi),
        CENTER_Z + r * Math.sin(phi) * Math.cos(theta)
      );
      this._camera.lookAt(CENTER_X, CENTER_Y, CENTER_Z);
    }

    // Sky background colour matching the 2D drawSky logic
    _skyColor(snap) {
      const dp   = snap?.time?.day_progress ?? 0.5;
      const cond = snap?.weather?.condition  ?? 0;
      let df;
      if      (dp < 0.18) df = 0;
      else if (dp < 0.28) df = (dp - 0.18) * 10;
      else if (dp < 0.72) df = 1;
      else if (dp < 0.82) df = 1 - (dp - 0.72) * 10;
      else                df = 0;
      const dayColors = [0x1A78C8, 0x2288CC, 0x556677, 0x334455, 0x111827, 0x8899AA, 0x7788AA];
      const dayCo = dayColors[cond] ?? 0x1A78C8;
      return df < 0.5
        ? lerpHex(0x000510, 0xBB4410, df * 2)
        : lerpHex(0xBB4410, dayCo, (df - 0.5) * 2);
    }

    update(snap) {
      this._renderer.setClearColor(this._skyColor(snap), 1);

      // Rebuild plants only when the layout changes (aquarium switch, first load).
      // Fingerprint is cheap: counts + first x of each layer.
      if (snap.plants) {
        const p = snap.plants;
        const fp = `${(p.bg||[]).length}:${(p.bg||[])[0]?.x}|`
                 + `${(p.weeds||[]).length}:${(p.weeds||[])[0]?.x}|`
                 + `${(p.hornwort||[]).length}:${(p.hornwort||[])[0]?.x}`;
        if (fp !== this._plantKey) {
          this._plantKey = fp;
          this._buildPlants(p);
        }
      }

      const fish = snap?.fish ?? [];
      const seen = new Set();

      for (const f of fish) {
        seen.add(f.id);
        const target = mapPos(f.x, f.y, f.z ?? 0);

        let grp = this._fishMeshes.get(f.id);
        if (!grp) {
          const col = (typeof f.color === 'number' && f.color >= 0) ? f.color : 0x33D17A;
          grp = this._makeFishGroup(col, f.type || 0);
          this._fishGroup.add(grp);
          this._fishMeshes.set(f.id, grp);
        }

        grp.position.copy(target);
        grp.rotation.y = (f.facing_right !== false) ? 0 : Math.PI;

        // Colour update (luck/shiny can change after creation)
        const col = (typeof f.color === 'number' && f.color >= 0) ? f.color : 0x33D17A;
        if (grp._bodyMat) grp._bodyMat.color.setHex(col);
      }

      // Remove groups for fish that are gone
      for (const [id, grp] of this._fishMeshes) {
        if (!seen.has(id)) {
          this._fishGroup.remove(grp);
          this._fishMeshes.delete(id);
        }
      }

      // ── Decorative snail (snap.snail) ─────────────────────────────────────
      if (snap.snail && typeof snap.snail.x === 'number') {
        if (!this._snailDecorMesh) {
          this._snailDecorMesh = this._makeSnailGroup(false);
          this._scene.add(this._snailDecorMesh);
        }
        const sn = snap.snail;
        this._snailDecorMesh.position.set((sn.x / 800) * TANK_W, 0, TANK_D * 0.45);
        this._snailDecorMesh.rotation.y = (sn.facing_right !== false) ? 0 : Math.PI;
        const sc = typeof sn.scale === 'number' ? Math.max(0.3, Math.min(1, sn.scale)) : 1;
        this._snailDecorMesh.scale.setScalar(sc);
      } else if (this._snailDecorMesh) {
        this._scene.remove(this._snailDecorMesh);
        this._snailDecorMesh = null;
      }

      // ── Career coin-collector snails (snap.snails) ────────────────────────
      const collectors = Array.isArray(snap.snails) ? snap.snails : [];
      const seenC = new Set();
      for (let i = 0; i < collectors.length; i++) {
        seenC.add(i);
        const sn = collectors[i];
        let mesh = this._snailCollectors.get(i);
        if (!mesh) {
          mesh = this._makeSnailGroup(true);
          this._scene.add(mesh);
          this._snailCollectors.set(i, mesh);
        }
        // Spread collectors slightly in z so they don't all stack on one line
        mesh.position.set((sn.x / 800) * TANK_W, 0, TANK_D * (0.36 + i * 0.05));
        mesh.rotation.y = (sn.facing_right !== false) ? 0 : Math.PI;
        const sc = typeof sn.scale === 'number' ? Math.max(0.3, Math.min(1, sn.scale)) : 1;
        mesh.scale.setScalar(sc);
      }
      for (const [i, mesh] of this._snailCollectors) {
        if (!seenC.has(i)) {
          this._scene.remove(mesh);
          this._snailCollectors.delete(i);
        }
      }

      // ── Starfish (snap.starfish) ───────────────────────────────────────────
      if (snap.starfish && typeof snap.starfish.x === 'number') {
        if (!this._starfishMesh) {
          this._starfishMesh = this._makeStarfishGroup();
          this._scene.add(this._starfishMesh);
        }
        this._starfishMesh.position.set(
          (snap.starfish.x / 800) * TANK_W, 0.04, TANK_D * 0.55);
        this._starfishMesh.rotation.y += 0.003; // gentle spin matching 2D wobble
      } else if (this._starfishMesh) {
        this._scene.remove(this._starfishMesh);
        this._starfishMesh = null;
      }
    }

    _animate() {
      requestAnimationFrame(() => this._animate());
      this._renderer.render(this._scene, this._camera);
    }
  }

  window.Tank3D = Tank3D;
})();
