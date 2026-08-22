/*
 * dice-3d.js —— 基于 Three.js 的真多面体骰子引擎
 *
 * 每种面数对应真实骰子的几何体：
 *   D4  正四面体   D6 正方体   D8 正八面体
 *   D10 五角十二面体(trapezohedron)   D12 正十二面体   D20 正二十面体
 *
 * 思路：
 *  1. 用 Three.js 内置多面体（D10 手工构造）得到 BufferGeometry；
 *  2. 把三角形按法线聚类成「逻辑面」，得到每个面的中心、法线；
 *  3. 每个逻辑面贴一块写着点数的 canvas 贴图（D6 用点阵）；
 *  4. 投掷时给随机角速度自由翻滚 + 从空中落下回弹，
 *     最后用四元数 slerp 把「目标点数所在面」的法线转向摄像机，定格。
 */
(function (global) {
  "use strict";

  const TAU = Math.PI * 2;

  // ---- 几何体构造 ----------------------------------------------------------

  // 五角十二面体（标准 d10 形状）：上下各一个顶点，中间两圈各 5 个交错的顶点，
  // 共 10 个风筝形面。手工构造，保证能稳定得到 10 个逻辑面。
  function makeD10Geometry(radius) {
    const geom = new THREE.BufferGeometry();
    const top = [0, 1.0, 0];
    const bot = [0, -1.0, 0];
    const ringY = 0.18;      // 上下两圈的高度
    const r = 1.0;           // 两圈半径
    const upper = [], lower = [];
    for (let i = 0; i < 5; i++) {
      const aU = (i / 5) * TAU;
      const aL = aU + TAU / 10; // 下圈相对上圈错开 36°
      upper.push([Math.cos(aU) * r, ringY, Math.sin(aU) * r]);
      lower.push([Math.cos(aL) * r, -ringY, Math.sin(aL) * r]);
    }
    const positions = [];
    const faceOfTri = []; // 每个三角形属于哪个逻辑面
    let faceId = 0;
    function tri(a, b, c) { positions.push(...a, ...b, ...c); faceOfTri.push(faceId); }
    // 上半 5 个风筝面：top - upper[i] - lower[i] - upper[i+1]
    // 顶点按此绕序时法线朝外（与下半一致），避免被背面剔除导致上半镂空
    for (let i = 0; i < 5; i++) {
      const u0 = upper[i], u1 = upper[(i + 1) % 5], lo = lower[i];
      tri(top, lo, u0); tri(top, u1, lo);
      faceId++;
    }
    // 下半 5 个风筝面：bot - lower[i] - upper[i+1] - lower[i+1]
    for (let i = 0; i < 5; i++) {
      const l0 = lower[i], l1 = lower[(i + 1) % 5], up = upper[(i + 1) % 5];
      tri(bot, l0, up); tri(bot, up, l1);
      faceId++;
    }
    geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geom.userData.faceOfTri = faceOfTri;
    geom.scale(radius, radius, radius);
    geom.computeVertexNormals();
    return geom;
  }

  function makeGeometry(faces, radius) {
    switch (faces) {
      case 4:  return new THREE.TetrahedronGeometry(radius);
      case 6:  return roundedBox(radius);
      case 8:  return new THREE.OctahedronGeometry(radius);
      case 10: return makeD10Geometry(radius);
      case 12: return new THREE.DodecahedronGeometry(radius);
      case 20: return new THREE.IcosahedronGeometry(radius);
      default: return new THREE.BoxGeometry(radius * 1.4, radius * 1.4, radius * 1.4);
    }
  }

  // d6 用略带体积感的正方体（边长≈2r/√3 使外接球半径一致）
  function roundedBox(radius) {
    const s = (radius * 2) / Math.sqrt(3);
    return new THREE.BoxGeometry(s, s, s);
  }

  // ---- 逻辑面提取 ----------------------------------------------------------

  // 把三角形按法线方向聚类为逻辑面，返回 [{ normal, center }]
  function extractFaces(geom) {
    // 索引化的几何体（如 BoxGeometry）要先展开成非索引，才能按三角形遍历
    const src = geom.getIndex() ? geom.toNonIndexed() : geom;
    const pos = src.getAttribute("position");
    const triCount = pos.count / 3;
    const faceOfTri = src.userData.faceOfTri || geom.userData.faceOfTri || null;
    const groups = new Map(); // key -> { normal, centerSum, n }

    const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
    const cb = new THREE.Vector3(), ab = new THREE.Vector3(), nrm = new THREE.Vector3();

    for (let t = 0; t < triCount; t++) {
      vA.fromBufferAttribute(pos, t * 3);
      vB.fromBufferAttribute(pos, t * 3 + 1);
      vC.fromBufferAttribute(pos, t * 3 + 2);
      cb.subVectors(vC, vB); ab.subVectors(vA, vB);
      nrm.copy(cb).cross(ab).normalize();
      const center = new THREE.Vector3().add(vA).add(vB).add(vC).multiplyScalar(1 / 3);

      // 有显式面归属（d10）用它；否则按法线取整聚类
      const key = faceOfTri
        ? "f" + faceOfTri[t]
        : [nrm.x, nrm.y, nrm.z].map(v => Math.round(v * 100)).join(",");

      let g = groups.get(key);
      if (!g) { g = { normal: new THREE.Vector3(), centerSum: new THREE.Vector3(), n: 0 }; groups.set(key, g); }
      g.normal.add(nrm);
      g.centerSum.add(center);
      g.n++;
    }

    const out = [];
    groups.forEach(g => {
      out.push({
        normal: g.normal.divideScalar(g.n).normalize(),
        center: g.centerSum.divideScalar(g.n)
      });
    });
    return out;
  }

  // ---- 面贴图（点数 / 点阵） ----------------------------------------------

  const PIP_MAP = {
    1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8],
    5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8]
  };

  function faceTexture(value, usePips) {
    const S = 256;
    const cv = document.createElement("canvas");
    cv.width = cv.height = S;
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, S, S);
    if (usePips) {
      ctx.fillStyle = "#1e293b";
      const lit = PIP_MAP[value] || [];
      const pad = S * 0.22, gap = (S - pad * 2) / 2, rad = S * 0.085;
      lit.forEach(idx => {
        const cx = pad + (idx % 3) * gap;
        const cy = pad + Math.floor(idx / 3) * gap;
        ctx.beginPath(); ctx.arc(cx, cy, rad, 0, TAU); ctx.fill();
      });
    } else {
      ctx.fillStyle = "#1e293b";
      ctx.font = "bold " + Math.round(S * 0.5) + "px 'Segoe UI', system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const label = String(value);
      ctx.fillText(label, S / 2, S / 2 + S * 0.02);
      // 6/9 加下划线避免混淆
      if (value === 6 || value === 9) {
        ctx.lineWidth = S * 0.03;
        ctx.strokeStyle = "#1e293b";
        ctx.beginPath();
        ctx.moveTo(S * 0.36, S * 0.74); ctx.lineTo(S * 0.64, S * 0.74); ctx.stroke();
      }
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.anisotropy = 4;
    return tex;
  }

  // ---- 单颗骰子 ------------------------------------------------------------

  const DIE_RADIUS = 0.95;

  // 构建一颗骰子（THREE.Group）：多面体网格 + 每个逻辑面的数字贴片
  // 返回 { group, faces: [{ value, normal }] } —— normal 为局部坐标法线
  function buildDie(facesCount) {
    const geom = makeGeometry(facesCount, DIE_RADIUS);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xf4f7fb, roughness: 0.35, metalness: 0.05,
      flatShading: facesCount !== 6
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const group = new THREE.Group();
    group.add(mesh);

    const logical = extractFaces(geom);
    const usePips = facesCount === 6;

    // 给逻辑面编号 1..N。d6 让相对面之和为 7。
    const faceInfo = assignValues(logical, facesCount);

    const labelScale = labelSizeFor(facesCount);
    faceInfo.forEach(f => {
      const tex = faceTexture(f.value, usePips);
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(labelScale, labelScale),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
      );
      // 贴片放在真实面中心稍微外移一点，法线朝外
      const n = f.normal.clone().normalize();
      plane.position.copy(f.center).add(n.clone().multiplyScalar(0.012));
      plane.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      group.add(plane);
    });

    return { group, faces: faceInfo };
  }

  function labelSizeFor(faces) {
    if (faces === 4) return 0.7;
    if (faces === 6) return 1.05;
    if (faces === 8) return 0.72;
    if (faces === 10) return 0.62;
    if (faces === 12) return 0.72;
    if (faces === 20) return 0.5;
    return 0.7;
  }

  // 给逻辑面分配点数；d6 保证相对面和为 7
  function assignValues(logical, facesCount) {
    // center 为真实面中心；normal 用面中心方向（凸多面体上即朝外法线，稳定）
    const info = logical.map(f => ({
      value: 0,
      center: f.center.clone(),
      normal: f.center.clone().normalize()
    }));

    if (facesCount === 6) {
      const used = new Array(info.length).fill(false);
      let next = 1;
      for (let i = 0; i < info.length; i++) {
        if (used[i]) continue;
        // 找相对面（法线相反）
        let opp = -1, best = 2; // 找 dot 最小（法线最相反）的面
        for (let j = 0; j < info.length; j++) {
          if (j === i || used[j]) continue;
          const d = info[i].normal.dot(info[j].normal);
          if (d < best) { best = d; opp = j; }
        }
        info[i].value = next;
        used[i] = true;
        if (opp >= 0) { info[opp].value = 7 - next; used[opp] = true; }
        next++;
      }
    } else {
      info.forEach((f, i) => { f.value = i + 1; });
    }
    return info;
  }

  // ---- 场景 ----------------------------------------------------------------

  function DiceScene(container) {
    this.container = container;
    this.dice = [];        // [{ group, faces }]
    this.anim = [];        // 每颗骰子的动画状态
    this.rolling = false;
    this._init();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
    this._bindOrbit();
    window.addEventListener("resize", () => this._resize());
  }

  DiceScene.prototype._init = function () {
    const w = this.container.clientWidth || 480;
    const h = this.container.clientHeight || 270;

    const scene = new THREE.Scene();
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 100);
    this.camDist = 9;
    this.camYaw = 0;         // 水平旋转
    this.camPitch = 0.92;    // 俯视角（弧度，从 y 轴往下）
    this.camera = camera;
    this._updateCamera();

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.container.appendChild(renderer.domElement);
    this.renderer = renderer;

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 0.95);
    key.position.set(4, 9, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 1; key.shadow.camera.far = 30;
    key.shadow.camera.left = -8; key.shadow.camera.right = 8;
    key.shadow.camera.top = 8; key.shadow.camera.bottom = -8;
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x88bbff, 0.35);
    fill.position.set(-5, 4, -3);
    scene.add(fill);

    // 接收阴影的地面（透明，只显示阴影，让 CSS 毛毡背景透出来）
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.ShadowMaterial({ opacity: 0.32 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0;
    floor.receiveShadow = true;
    scene.add(floor);

    this.diceRoot = new THREE.Group();
    scene.add(this.diceRoot);
  };

  DiceScene.prototype._updateCamera = function () {
    const d = this.camDist;
    const y = Math.cos(this.camPitch) * d;
    const horiz = Math.sin(this.camPitch) * d;
    this.camera.position.set(
      Math.sin(this.camYaw) * horiz,
      Math.max(1.5, y) + 2.5,
      Math.cos(this.camYaw) * horiz + 0.001
    );
    this.camera.lookAt(0, 0.4, 0);
  };

  DiceScene.prototype._resize = function () {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  };

  // 依据面数与数量摆放骰子（静止展示态）
  DiceScene.prototype.setup = function (facesCount, count) {
    this.facesCount = facesCount;
    // 清掉旧骰子
    while (this.diceRoot.children.length) this.diceRoot.remove(this.diceRoot.children[0]);
    this.dice = [];
    this.anim = [];

    const positions = layout(count);
    for (let i = 0; i < count; i++) {
      const die = buildDie(facesCount);
      const p = positions[i];
      die.group.position.set(p.x, DIE_RADIUS, p.z);
      die.group.rotation.set(0.5, 0.7, 0.2);
      this.diceRoot.add(die.group);
      this.dice.push(die);
    }
    this.restY = DIE_RADIUS;
    this.idleSpin = true; // 掷之前缓慢自转展示；落定后关闭以保持点数朝上
  };

  // 网格布点，随数量自动铺开
  function layout(count) {
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);
    const spacing = 2.4;
    const out = [];
    for (let i = 0; i < count; i++) {
      const r = Math.floor(i / cols), c = i % cols;
      const colsThis = (r === rows - 1) ? (count - cols * (rows - 1)) : cols;
      out.push({
        x: (c - (colsThis - 1) / 2) * spacing,
        z: (r - (rows - 1) / 2) * spacing
      });
    }
    return out;
  }

  DiceScene.prototype._bindOrbit = function () {
    const el = this.renderer.domElement;
    let dragging = false, lx = 0, ly = 0;
    const down = (x, y) => { dragging = true; lx = x; ly = y; };
    const move = (x, y) => {
      if (!dragging) return;
      this.camYaw -= (x - lx) * 0.008;
      this.camPitch = Math.max(0.35, Math.min(1.4, this.camPitch - (y - ly) * 0.006));
      lx = x; ly = y;
      this._updateCamera();
    };
    const up = () => { dragging = false; };
    el.addEventListener("mousedown", e => down(e.clientX, e.clientY));
    window.addEventListener("mousemove", e => move(e.clientX, e.clientY));
    window.addEventListener("mouseup", up);
    el.addEventListener("touchstart", e => { const t = e.touches[0]; down(t.clientX, t.clientY); }, { passive: true });
    el.addEventListener("touchmove", e => { const t = e.touches[0]; move(t.clientX, t.clientY); }, { passive: true });
    el.addEventListener("touchend", up);
  };

  // 计算让「目标面法线」朝向摄像机偏上的目标四元数
  DiceScene.prototype._targetQuat = function (die, value) {
    const face = die.faces.find(f => f.value === value) || die.faces[0];
    const localN = face.normal.clone().normalize();
    // 希望该面朝向的世界方向：从骰子指向摄像机，略微朝上（读数清晰）
    const toCam = this.camera.position.clone().sub(new THREE.Vector3(0, this.restY, 0)).normalize();
    const aim = toCam.clone().add(new THREE.Vector3(0, 0.35, 0)).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(localN, aim);
    return q;
  };

  // 投掷：finals 为每颗骰子的最终点数数组；done 为全部定格后的回调
  DiceScene.prototype.roll = function (finals, done) {
    if (this.rolling) return;
    this.rolling = true;
    this._onDone = done;
    const now = performance.now();
    this.anim = this.dice.map((die, i) => {
      const stagger = i * 130;
      const startQ = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(rand(TAU), rand(TAU), rand(TAU))
      );
      die.group.quaternion.copy(startQ);
      return {
        die,
        value: finals[i],
        t0: now + stagger,
        tumbleMs: 900,
        settleMs: 480,
        // 翻滚角速度
        spin: new THREE.Vector3((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14),
        startQ: startQ,
        targetQ: this._targetQuat(die, finals[i]),
        settling: false,
        settleFromQ: null,
        settleT0: 0,
        dropH: 5 + Math.random() * 2,   // 起始高度
        landed: false,
        homeX: die.group.position.x,
        homeZ: die.group.position.z,
        last: now + stagger
      };
    });
  };

  function rand(m) { return Math.random() * m; }
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function easeOutBack(t) { const c = 1.70158, c3 = c + 1; return 1 + c3 * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); }

  DiceScene.prototype._loop = function (now) {
    requestAnimationFrame(this._loop);

    if (this.rolling && this.anim.length) {
      let allDone = true;
      for (const a of this.anim) {
        const g = a.die.group;
        if (now < a.t0) { allDone = false; continue; }

        if (!a.settling) {
          const el = now - a.t0;
          // 自由翻滚
          const dt = Math.min(0.05, (now - a.last) / 1000);
          a.last = now;
          const dq = new THREE.Quaternion().setFromEuler(
            new THREE.Euler(a.spin.x * dt, a.spin.y * dt, a.spin.z * dt)
          );
          g.quaternion.premultiply(dq);
          // 落下 + 回弹高度
          const p = Math.min(1, el / a.tumbleMs);
          const bounce = a.dropH * (1 - easeOutBounce(p));
          g.position.y = this.restY + bounce;
          if (p >= 1) { a.settling = true; a.settleFromQ = g.quaternion.clone(); a.settleT0 = now; }
          allDone = false;
        } else {
          const p = Math.min(1, (now - a.settleT0) / a.settleMs);
          const e = easeOutCubic(p);
          g.quaternion.copy(a.settleFromQ).slerp(a.targetQ, e);
          g.position.y = this.restY + (1 - e) * 0.25 * Math.sin(p * Math.PI);
          if (p >= 1) { a.landed = true; g.quaternion.copy(a.targetQ); g.position.y = this.restY; }
          else allDone = false;
        }
      }
      if (allDone) {
        this.rolling = false;
        this.idleSpin = false; // 落定后停止自转，保持掷出的那一面朝上
        this.anim = [];
        if (this._onDone) { const cb = this._onDone; this._onDone = null; cb(); }
      }
    } else if (!this.rolling && this.idleSpin) {
      // 掷之前的静止展示：缓慢自转，突出立体感
      const t = now * 0.0004;
      this.dice.forEach((d, i) => { d.group.rotation.y = 0.7 + t + i * 0.4; });
    }

    this.renderer.render(this.scene, this.camera);
  };

  function easeOutBounce(t) {
    const n1 = 7.5625, d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) { t -= 1.5 / d1; return n1 * t * t + 0.75; }
    if (t < 2.5 / d1) { t -= 2.25 / d1; return n1 * t * t + 0.9375; }
    t -= 2.625 / d1; return n1 * t * t + 0.984375;
  }

  global.DiceGeom = {
    makeGeometry, makeD10Geometry, extractFaces, faceTexture,
    buildDie, DIE_RADIUS
  };
  global.DiceScene = DiceScene;
})(window);
