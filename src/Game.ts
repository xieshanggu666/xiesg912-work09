import type p5 from 'p5';
import Matter from 'matter-js';
import { AudioEngine } from './audio/AudioEngine';
import type { StepVoice, WeatherKind } from './audio/AudioEngine';
import { MicRecorder } from './audio/MicRecorder';
import { Fragment } from './world/Fragment';
import type { VoiceAudio } from './world/Fragment';
import { NoteField } from './world/Notes';
import { Weather } from './world/Weather';
import { Panel } from './ui/Panel';
import { Portfolio } from './data/Portfolio';
import type { FragmentDoc, SongDoc } from './data/Portfolio';
import { bytesToBase64, base64ToBytes, QuotaError, ImportError } from './data/Portfolio';

const SCALE = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25];
const SOLFEGE = ['do', 're', 'mi', 'sol', 'la', 'do', 're', 'mi'];
const COLORS = ['#ff8a80', '#ffd180', '#ffff8d', '#ccff90', '#80d8ff', '#8c9eff', '#ea80fc', '#a7ffeb'];
const TIMBRES: Array<'sine' | 'triangle' | 'square'> = ['sine', 'triangle', 'square'];
const SLOT_COUNT = 6;
const VOICE_COLOR = '#ffab40';
const WEATHER_CYCLE: WeatherKind[] = ['sunny', 'rain', 'wind'];
const WEATHER_AUTO_MS = 75_000;

interface Drag {
  frag: Fragment;
  dx: number;
  dy: number;
  x: number;
  y: number;
  px: number;
  py: number;
  pt: number;
  vx: number;
  vy: number;
}

export class Game {
  private p!: p5;
  private canvasEl!: HTMLCanvasElement;
  private audio = new AudioEngine();
  private mic = new MicRecorder();
  private panel!: Panel;
  private weather = new Weather();
  private notes = new NoteField(SLOT_COUNT, SCALE);
  private portfolio = new Portfolio();
  private currentSongId: string | null = null;
  private fragments: Fragment[] = [];
  private slots: (Fragment | null)[] = Array(SLOT_COUNT).fill(null);
  private engine = Matter.Engine.create({ gravity: { x: 0, y: 0.35, scale: 0.001 } });

  private flow = 0.4;
  private level = 0.5;
  private weatherKind: WeatherKind = 'sunny';
  private lastWeatherSwitch = 0;

  private drags = new Map<number, Drag>();
  private collected = 0;
  private pulseStep = -1;
  private pulseAt = 0;
  private celebrating = false;
  private micTimer: number | null = null;
  /** 打开作品时正在异步解码录音，期间忽略重复打开/录音，避免河流状态竞争 */
  private restoring = false;

  sketch = (p: p5): void => {
    p.setup = () => this.setup(p);
    p.draw = () => this.drawFrame();
    p.windowResized = () => this.resized();
  };

  private setup(p: p5): void {
    this.p = p;
    const renderer = p.createCanvas(p.windowWidth, p.windowHeight);
    this.canvasEl = renderer.elt as HTMLCanvasElement;
    p.textFont('system-ui, sans-serif');
    p.textAlign(p.CENTER, p.CENTER);

    for (let i = 0; i < SCALE.length; i++) {
      const frag = new Fragment(
        {
          id: this.toneId(i),
          kind: 'tone',
          toneIndex: i,
          freq: SCALE[i],
          timbre: TIMBRES[i % TIMBRES.length],
          color: COLORS[i],
          label: SOLFEGE[i],
        },
        (i + 0.5) * (p.width / SCALE.length),
        this.surfaceY() + 20
      );
      this.fragments.push(frag);
      Matter.Composite.add(this.engine.world, frag.body);
    }

    this.notes.layout(p.width, p.height);

    this.audio.setVoiceProvider((step) => this.voiceFor(step));
    this.audio.onStep = (s) => {
      this.pulseStep = s;
      this.pulseAt = p.millis();
    };
    this.audio.setFlow(this.flow);
    this.audio.setLevel(this.level);

    this.panel = new Panel({
      onFlow: (v) => {
        this.flow = v;
        this.audio.setFlow(v);
      },
      onLevel: (v) => {
        this.level = v;
        this.audio.setLevel(v);
      },
      onWeather: (w) => this.setWeather(w),
      onMic: () => void this.toggleMic(),
      onMute: (m) => this.audio.setMuted(m),
      onAnyGesture: () => void this.audio.unlock(),
      onSaveSong: (name, asNew) => this.saveSong(name, asNew),
      onOpenSong: (id) => void this.openSong(id),
      onDeleteSong: (id) => this.deleteSong(id),
      onExportSong: (id) => this.exportSong(id),
      onImportSong: (file) => void this.importSong(file),
    });
    this.panel.setNotes(0, SLOT_COUNT);
    this.refreshSongList();

    const canvas = this.canvasEl;
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onPointerUp(e));

    this.lastWeatherSwitch = p.millis();
  }

  // ---------- 主循环 ----------

  private drawFrame(): void {
    const p = this.p;
    const dt = Math.min(Math.max(p.deltaTime, 8), 33);
    const t = p.millis();

    // 装置待机时自动轮换天气（家长手动切换后重新计时）
    if (t - this.lastWeatherSwitch > WEATHER_AUTO_MS) {
      const next = WEATHER_CYCLE[(WEATHER_CYCLE.indexOf(this.weatherKind) + 1) % WEATHER_CYCLE.length];
      this.setWeather(next);
    }

    const surface = this.surfaceY();
    const gust = this.weather.windGust(t);
    const k = (dt / 16.666) ** 2;

    for (const frag of this.fragments) {
      if (frag.slotIndex !== null) continue;
      const body = frag.body;
      const drag = this.dragOf(frag);
      if (drag) {
        // 刚体在 onPointerDown 中已切为静态：直接贴住手指位置，
        // 避免快速拖拽时速度插值造成的滞后；并按指针轨迹记录甩动速度供松手时使用
        const tx = drag.x + drag.dx;
        const ty = drag.y + drag.dy;
        Matter.Body.setPosition(body, { x: tx, y: ty });
        const dms = Math.max(t - drag.pt, 1);
        drag.vx = ((tx - drag.px) / dms) * 16.666;
        drag.vy = ((ty - drag.py) / dms) * 16.666;
        drag.px = tx;
        drag.py = ty;
        drag.pt = t;
      } else {
        const depth = body.position.y - surface;
        const fx = (this.flow * 0.00015 + gust * 0.0005) * body.mass * k;
        let fy = 0;
        if (depth > 0) fy = -Math.min(depth / frag.h, 1.2) * 0.0011 * body.mass * k;
        if (this.weatherKind === 'rain') {
          fy += Math.sin(t * 0.02 + body.position.x) * 0.00006 * body.mass * k;
        }
        Matter.Body.applyForce(body, body.position, { x: fx, y: fy });
      }
    }
    Matter.Engine.update(this.engine, dt);

    // 水平环绕 + 防沉底
    for (const frag of this.fragments) {
      if (frag.slotIndex !== null || this.dragOf(frag)) continue;
      const { x, y } = frag.body.position;
      if (x < -frag.w) Matter.Body.setPosition(frag.body, { x: p.width + frag.w, y });
      else if (x > p.width + frag.w) Matter.Body.setPosition(frag.body, { x: -frag.w, y });
      if (y > p.height - frag.h / 2) {
        Matter.Body.setPosition(frag.body, { x, y: p.height - frag.h / 2 });
      }
    }

    this.weather.update(dt, this.flow, surface, p.width, p.height, t);
    this.notes.update(dt, surface);

    this.drawSky();
    this.drawRiver(surface, t);
    this.notes.draw(p, surface, t);
    for (const frag of this.fragments) {
      if (frag.slotIndex !== null) continue;
      frag.draw(p, frag.body.position.x, frag.body.position.y, frag.body.angle, 1);
    }
    this.drawSlots(t);
    this.weather.draw(p, surface, t);
  }

  // ---------- 输入 ----------

  private canvasPos(e: PointerEvent): { x: number; y: number } {
    const r = this.canvasEl.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (this.p.width / r.width),
      y: (e.clientY - r.top) * (this.p.height / r.height),
    };
  }

  private onPointerDown(e: PointerEvent): void {
    void this.audio.unlock();
    const { x, y } = this.canvasPos(e);
    const note = this.notes.hit(x, y, this.surfaceY());
    if (note) {
      this.collectNote(note);
      return;
    }
    const frag = this.fragmentAt(x, y);
    if (frag) {
      if (frag.slotIndex !== null) this.unslot(frag);
      // 切为静态刚体：拖拽期间完全跟随手指，不参与重力/浮力模拟
      Matter.Body.setStatic(frag.body, true);
      Matter.Body.setAngle(frag.body, 0);
      this.drags.set(e.pointerId, {
        frag,
        dx: frag.body.position.x - x,
        dy: frag.body.position.y - y,
        x,
        y,
        px: frag.body.position.x,
        py: frag.body.position.y,
        pt: this.p.millis(),
        vx: 0,
        vy: 0,
      });
      // 快速拖出画布时仍能收到 pointerup/pointercancel
      try {
        this.canvasEl.setPointerCapture(e.pointerId);
      } catch {
        /* 某些环境不支持，忽略即可 */
      }
    }
  }

  private onPointerMove(e: PointerEvent): void {
    const d = this.drags.get(e.pointerId);
    if (!d) return;
    const { x, y } = this.canvasPos(e);
    d.x = x;
    d.y = y;
  }

  private onPointerUp(e: PointerEvent): void {
    const d = this.drags.get(e.pointerId);
    if (!d) return;
    this.drags.delete(e.pointerId);
    try {
      this.canvasEl.releasePointerCapture(e.pointerId);
    } catch {
      /* 忽略 */
    }
    this.releaseDrag(d);
  }

  private releaseDrag(d: Drag): void {
    const frag = d.frag;
    // 以手指释放位置（含抓取偏移）判定格子。快速拖拽时手指已到格子、
    // 刚体此前可能还滞后在半空，用刚体位会判定失败
    const tx = d.x + d.dx;
    const ty = d.y + d.dy;
    const slot = this.slotAt(tx, ty);
    if (slot >= 0) {
      this.placeInSlot(frag, slot);
      return;
    }
    // 没放进格子：恢复动态物理，放回释放点并带上甩动速度（限幅，防止穿透）
    Matter.Body.setStatic(frag.body, false);
    Matter.Body.setPosition(frag.body, { x: tx, y: ty });
    const maxV = 18;
    Matter.Body.setVelocity(frag.body, {
      x: Math.max(-maxV, Math.min(maxV, d.vx)),
      y: Math.max(-maxV, Math.min(maxV, d.vy)),
    });
    Matter.Body.setAngularVelocity(frag.body, 0);
  }

  // ---------- 格子 / 音序器 ----------

  private voiceFor(step: number): StepVoice | null {
    const frag = this.slots[step];
    if (!frag) return null;
    return { freq: frag.spec.freq, timbre: frag.spec.timbre, buffer: frag.spec.buffer ?? null };
  }

  private placeInSlot(frag: Fragment, i: number, silent = false): void {
    const occupant = this.slots[i];
    if (occupant && occupant !== frag) {
      this.unslot(occupant, frag.body.position.x, frag.body.position.y);
      // 被换出的碎片可能同样来自拖拽（静态刚体），恢复动态以便落回河里
      Matter.Body.setStatic(occupant.body, false);
      Matter.Body.setVelocity(occupant.body, { x: 0, y: 0 });
    }
    Matter.Composite.remove(this.engine.world, frag.body);
    frag.slotIndex = i;
    this.slots[i] = frag;
    if (!silent) this.audio.pluckNow(frag.spec.freq * 2);
  }

  private unslot(frag: Fragment, x?: number, y?: number): void {
    if (frag.slotIndex === null) return;
    const i = frag.slotIndex;
    const s = this.slotPos(i);
    this.slots[i] = null;
    frag.slotIndex = null;
    Matter.Body.setPosition(frag.body, x !== undefined ? { x, y: y! } : s);
    Matter.Body.setVelocity(frag.body, { x: 0, y: 0 });
    Matter.Composite.add(this.engine.world, frag.body);
  }

  private slotSpacing(): number {
    return Math.min(this.p.width / (SLOT_COUNT + 0.5), 104);
  }

  private slotY(): number {
    return Math.max(56, this.p.height * 0.085);
  }

  private slotPos(i: number): { x: number; y: number } {
    const spacing = this.slotSpacing();
    return {
      x: this.p.width / 2 - (spacing * (SLOT_COUNT - 1)) / 2 + i * spacing,
      y: this.slotY(),
    };
  }

  private slotR(): number {
    return Math.min(this.slotSpacing() * 0.44, 38);
  }

  private slotAt(x: number, y: number): number {
    const r = this.slotR() * 1.6;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < SLOT_COUNT; i++) {
      const s = this.slotPos(i);
      const dx = x - s.x;
      const dy = y - s.y;
      // 精确落在圆形热区内
      if (dx * dx + dy * dy < r * r) return i;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    // 快速甩到顶部格子行附近：吸附到水平最近的格子，
    // 只要纵向在格子带内、横向不超过半个间距
    const s = this.slotPos(best);
    if (
      Math.abs(y - s.y) < this.slotR() * 2.1 &&
      Math.abs(x - s.x) < this.slotSpacing() * 0.55
    ) {
      return best;
    }
    return -1;
  }

  private fragmentAt(x: number, y: number): Fragment | null {
    const hitR = this.slotR() * 1.3;
    for (let i = 0; i < SLOT_COUNT; i++) {
      const frag = this.slots[i];
      if (!frag) continue;
      const s = this.slotPos(i);
      const dx = x - s.x;
      const dy = y - s.y;
      if (dx * dx + dy * dy < hitR * hitR) return frag;
    }
    for (let i = this.fragments.length - 1; i >= 0; i--) {
      const frag = this.fragments[i];
      if (frag.slotIndex !== null) continue;
      const b = frag.body.bounds;
      if (x >= b.min.x - 6 && x <= b.max.x + 6 && y >= b.min.y - 6 && y <= b.max.y + 6) return frag;
    }
    return null;
  }

  private dragOf(frag: Fragment): Drag | null {
    for (const d of this.drags.values()) if (d.frag === frag) return d;
    return null;
  }

  // ---------- 音符收集 ----------

  private collectNote(note: { freq: number; collected: boolean }): void {
    note.collected = true;
    this.collected++;
    this.panel.setNotes(this.collected, SLOT_COUNT);
    this.audio.chime(note.freq);
    if (this.collected === SLOT_COUNT && !this.celebrating) {
      this.celebrating = true;
      this.audio.fanfare();
      this.panel.toast('🎉 河流之歌完成啦！');
      window.setTimeout(() => {
        this.notes.layout(this.p.width, this.p.height);
        this.collected = 0;
        this.panel.setNotes(0, SLOT_COUNT);
        this.celebrating = false;
      }, 2200);
    }
  }

  // ---------- 录音 ----------

  private async toggleMic(): Promise<void> {
    if (this.mic.recording) {
      await this.stopMic();
      return;
    }
    if (this.restoring) {
      this.panel.toast('正在打开作品，稍等一下再录 ⏳');
      return;
    }
    try {
      await this.audio.unlock();
      await this.mic.start();
    } catch {
      this.panel.toast('打不开麦克风 😢 请检查权限');
      return;
    }
    this.panel.setMicRecording(true);
    this.panel.toast('🎙️ 录音中… 再点一下停止');
    this.micTimer = window.setTimeout(() => void this.stopMic(), 4000);
  }

  private async stopMic(): Promise<void> {
    if (this.micTimer !== null) {
      window.clearTimeout(this.micTimer);
      this.micTimer = null;
    }
    if (!this.mic.recording) return;
    const blob = await this.mic.stop();
    this.panel.setMicRecording(false);
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const buffer = await this.audio.decode(bytes.slice().buffer);
      const voice: VoiceAudio = { bytes, mime: blob.type || 'audio/webm', buffer };
      const frag = new Fragment(
        {
          id: `voice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          kind: 'voice',
          toneIndex: -1,
          freq: 261.63,
          timbre: 'sample',
          color: VOICE_COLOR,
          label: '🎙️',
          buffer,
          audio: voice,
        },
        this.p.width / 2,
        this.surfaceY() + 8
      );
      this.fragments.push(frag);
      Matter.Composite.add(this.engine.world, frag.body);
      this.panel.toast('你的声音游进河里啦！🐟');
    } catch {
      this.panel.toast('这段声音没法用 😢');
    }
  }

  // ---------- 天气 ----------

  private setWeather(w: WeatherKind): void {
    this.weatherKind = w;
    this.weather.setKind(w);
    this.audio.setWeather(w);
    this.panel.setWeatherActive(w);
    this.lastWeatherSwitch = this.p.millis();
  }

  // ---------- 本地作品集 ----------

  private toneId(i: number): string {
    return `tone-${i}`;
  }

  private refreshSongList(): void {
    this.panel.setSongs(this.portfolio.list(), this.currentSongId);
  }

  /** 把当前画面序列化成存档：格子顺序、空格、全部碎片（含录音）、流速、水位、天气 */
  private serializeSong(name: string, id: string, now: number): SongDoc {
    const fragments: FragmentDoc[] = this.fragments.map((f) => {
      const s = f.spec;
      const doc: FragmentDoc = {
        id: s.id,
        kind: s.kind,
        freq: s.freq,
        timbre: s.timbre,
        color: s.color,
        label: s.label,
        toneIndex: s.toneIndex,
      };
      if (s.kind === 'voice' && s.audio) {
        doc.audio = bytesToBase64(s.audio.bytes);
        doc.audioMime = s.audio.mime;
      }
      return doc;
    });
    return {
      id,
      name,
      createdAt: now,
      updatedAt: now,
      flow: this.flow,
      level: this.level,
      weather: this.weatherKind,
      slotCount: SLOT_COUNT,
      slots: this.slots.map((f) => (f ? f.id : null)),
      fragments,
      version: 1,
    };
  }

  private saveSong(name: string, asNew: boolean): void {
    const now = Date.now();
    // 覆盖当前作品沿用原 id 与创建时间；另存为或首次保存则新建
    const existing = this.currentSongId && !asNew ? this.portfolio.get(this.currentSongId) : null;
    const id = existing ? existing.id : Portfolio.newId();
    const doc = this.serializeSong(name, id, now);
    if (existing) doc.createdAt = existing.createdAt;
    try {
      this.portfolio.save(doc);
      this.currentSongId = id;
      this.refreshSongList();
      this.panel.toast(existing ? `已保存《${name}》💾` : `《${name}》收进作品集啦！📚`);
    } catch (e) {
      if (e instanceof QuotaError) this.panel.toast(e.message);
      else this.panel.toast('保存失败 😢 浏览器可能禁用了本地存储');
    }
  }

  private async openSong(id: string): Promise<void> {
    if (this.restoring) return;
    const doc = this.portfolio.get(id);
    if (!doc) {
      this.refreshSongList();
      return;
    }
    this.restoring = true;
    // 录音是用户手势（点击）触发的：趁机解锁音频，保证 decodeAudioData 可用
    await this.audio.unlock();
    try {
      await this.restoreSong(doc);
      this.currentSongId = id;
      this.refreshSongList();
      this.panel.toast(`打开《${doc.name}》♪`);
    } catch {
      this.panel.toast('这首歌打不开了 😢（录音数据可能损坏）');
    } finally {
      this.restoring = false;
    }
  }

  private deleteSong(id: string): void {
    this.portfolio.remove(id);
    if (this.currentSongId === id) this.currentSongId = null;
    this.refreshSongList();
    this.panel.toast('已删除 🗑️');
  }

  /** 单首作品备份文件的大小上限：单首（含若干段 4 秒录音）远超此值即可判定为选错文件 */
  private static MAX_IMPORT_BYTES = 8_000_000;

  /** 导出单首作品为 .json 备份文件，家长可发到另一台设备再导入 */
  private exportSong(id: string): void {
    const exported = this.portfolio.exportSong(id);
    if (!exported) {
      this.refreshSongList();
      return;
    }
    // 文件名沿用作品名，只替换掉各平台文件系统不接受的字符
    const safe = exported.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || '河流之歌';
    const url = URL.createObjectURL(new Blob([exported.json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safe}.river-song.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 延后回收：iOS Safari 立即 revoke 会取消还没开始的下载
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    this.panel.toast(`已导出《${exported.name}》📤 发到另一台设备后点「导入作品备份」`);
  }

  /** 从备份文件导入一首作品；只进列表不自动打开，避免覆盖孩子正在玩的河流 */
  private async importSong(file: File): Promise<void> {
    if (file.size > Game.MAX_IMPORT_BYTES) {
      this.panel.toast('这个文件太大，不像是作品备份 🤔');
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      this.panel.toast('读不了这个文件 😢');
      return;
    }
    try {
      const { doc, copied } = this.portfolio.importSong(text);
      this.refreshSongList();
      this.panel.toast(
        copied
          ? `已导入《${doc.name}》：本机已有同一首，存成了新作品 📥`
          : `《${doc.name}》回到作品集啦！📥`
      );
    } catch (e) {
      if (e instanceof ImportError || e instanceof QuotaError) this.panel.toast(e.message);
      else this.panel.toast('导入失败 😢 这个文件可能不是作品备份');
    }
  }

  /** 按存档重建整条河流：还原因速/水位 → 清场 → 建碎片 → 摆格子 → 天气 */
  private async restoreSong(doc: SongDoc): Promise<void> {
    const p = this.p;
    this.drags.clear();

    // 先恢复水位（决定河面高度），碎片初始位置才会落在正确的水里
    this.flow = doc.flow;
    this.level = doc.level;
    this.audio.setFlow(this.flow);
    this.audio.setLevel(this.level);
    this.panel.setFlow(this.flow);
    this.panel.setLevel(this.level);

    // 清掉旧碎片的物理体
    for (const f of this.fragments) Matter.Composite.remove(this.engine.world, f.body);
    this.fragments = [];
    this.slots = Array(SLOT_COUNT).fill(null);

    // 解码全部录音（AudioBuffer 无法直接 JSON 化，只持久化了编码字节）
    const restored: Fragment[] = [];
    for (const fd of doc.fragments) {
      let voice: VoiceAudio | null = null;
      if (fd.kind === 'voice') {
        if (!fd.audio) continue;
        try {
          const bytes = base64ToBytes(fd.audio);
          const buffer = await this.audio.decode(bytes.slice().buffer);
          voice = { bytes, mime: fd.audioMime || 'audio/webm', buffer };
        } catch {
          // 单条录音损坏（base64/编码无法解码）只跳过它，不影响整首歌恢复
          continue;
        }
      }
      const spec =
        fd.kind === 'tone' && fd.toneIndex >= 0 && fd.toneIndex < SCALE.length
          ? {
              // 内置音符以音阶表为准，忽略存档里被改动的视觉/音高字段
              id: this.toneId(fd.toneIndex),
              kind: 'tone' as const,
              toneIndex: fd.toneIndex,
              freq: SCALE[fd.toneIndex],
              timbre: TIMBRES[fd.toneIndex % TIMBRES.length],
              color: COLORS[fd.toneIndex],
              label: SOLFEGE[fd.toneIndex],
            }
          : {
              id: fd.id,
              kind: 'voice' as const,
              toneIndex: -1,
              freq: fd.freq || 261.63,
              timbre: 'sample' as const,
              color: fd.color || VOICE_COLOR,
              label: fd.label || '🎙️',
              buffer: voice?.buffer ?? null,
              audio: voice,
            };
      // 先都放在河面，稍后把属于格子的静默移入格子
      const x = ((restored.length + 0.5) / Math.max(doc.fragments.length, 1)) * p.width;
      restored.push(new Fragment(spec, x, this.surfaceY() + 20));
    }

    // 存档若缺内置音符（旧版本/异常数据），补齐 8 块固定音阶
    for (let i = 0; i < SCALE.length; i++) {
      if (!restored.some((f) => f.id === this.toneId(i))) {
        restored.push(
          new Fragment(
            {
              id: this.toneId(i),
              kind: 'tone',
              toneIndex: i,
              freq: SCALE[i],
              timbre: TIMBRES[i % TIMBRES.length],
              color: COLORS[i],
              label: SOLFEGE[i],
            },
            (i + 0.5) * (p.width / SCALE.length),
            this.surfaceY() + 20
          )
        );
      }
    }

    for (const f of restored) Matter.Composite.add(this.engine.world, f.body);
    this.fragments = restored;
    const byId = new Map(restored.map((f) => [f.id, f]));

    // 恢复格子顺序与空格：按存档逐格摆放，引用不到的格子留空
    this.slots = Array(SLOT_COUNT).fill(null);
    const slotCount = doc.slotCount || SLOT_COUNT;
    for (let i = 0; i < SLOT_COUNT; i++) {
      const fid = i < slotCount ? doc.slots[i] ?? null : null;
      const frag = fid ? byId.get(fid) : null;
      if (frag) this.placeInSlot(frag, i, true);
    }
    // 多块录音落在同一格等异常情况下，保证每条声音都还在河里，不会无声消失
    for (const f of restored) {
      if (f.slotIndex !== null && !this.slots.includes(f)) {
        f.slotIndex = null;
        Matter.Composite.add(this.engine.world, f.body);
      }
    }

    // 恢复天气（同步粒子、环境声与面板高亮，并重置待机轮换计时）
    this.setWeather(doc.weather);

    // 收集进度不属于某首歌：重置一轮，避免 HUD 数字与画面音符对不上
    this.collected = 0;
    this.panel.setNotes(0, SLOT_COUNT);
    this.notes.layout(p.width, p.height);
  }

  // ---------- 渲染 ----------

  private surfaceY(): number {
    return this.p.height * (0.62 - 0.32 * this.level);
  }

  private waveY(x: number, surface: number, t: number): number {
    return (
      surface +
      Math.sin(x * 0.02 + t * 0.002 * (1 + this.flow * 3)) * 4 +
      Math.sin(x * 0.045 - t * 0.0032) * 2.5
    );
  }

  private drawSky(): void {
    const p = this.p;
    const ctx = p.drawingContext as CanvasRenderingContext2D;
    const [top, bottom] = this.weather.skyColors();
    const g = ctx.createLinearGradient(0, 0, 0, p.height);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, p.width, p.height);
  }

  private drawRiver(surface: number, t: number): void {
    const p = this.p;
    const ctx = p.drawingContext as CanvasRenderingContext2D;

    const g = ctx.createLinearGradient(0, surface, 0, p.height);
    g.addColorStop(0, 'rgba(80,170,255,0.45)');
    g.addColorStop(1, 'rgba(8,50,110,0.8)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, surface);
    for (let x = 0; x <= p.width; x += 14) ctx.lineTo(x, this.waveY(x, surface, t));
    ctx.lineTo(p.width, p.height);
    ctx.lineTo(0, p.height);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x <= p.width; x += 14) {
      const y = this.waveY(x, surface, t);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // 随流速加快的水纹
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    const depth = p.height - surface;
    for (let i = 0; i < 10; i++) {
      const speed = 0.03 + this.flow * 0.3;
      const sx = ((i * 197 + t * speed) % (p.width + 140)) - 70;
      const sy = surface + 16 + ((i * 53) % Math.max(20, depth - 40));
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + 24 + this.flow * 50, sy);
      ctx.stroke();
    }
  }

  private drawSlots(t: number): void {
    const p = this.p;
    const y = this.slotY();
    p.stroke(255, 255, 255, 90);
    p.strokeWeight(2);
    p.line(20, y, p.width - 20, y);

    for (let i = 0; i < SLOT_COUNT; i++) {
      const s = this.slotPos(i);
      const r = this.slotR();
      let pulse = 1;
      if (i === this.pulseStep) pulse = 1 + 0.22 * Math.exp(-(t - this.pulseAt) / 130);
      p.push();
      p.translate(s.x, s.y);
      p.scale(pulse);
      p.noFill();
      p.stroke(255, 255, 255, 170);
      p.strokeWeight(2);
      p.drawingContext.setLineDash([5, 6]);
      p.circle(0, 0, r * 2);
      p.drawingContext.setLineDash([]);
      p.pop();
      const frag = this.slots[i];
      if (frag) frag.draw(p, s.x, s.y, 0, pulse * ((r * 1.9) / frag.w));
    }
  }

  private resized(): void {
    this.p.resizeCanvas(this.p.windowWidth, this.p.windowHeight);
    this.notes.resize(this.p.width, this.p.height);
  }
}
