import type { WeatherKind } from '../audio/AudioEngine';
import type { SongSummary } from '../data/Portfolio';

export interface PanelCallbacks {
  onFlow: (v: number) => void;
  onLevel: (v: number) => void;
  onWeather: (w: WeatherKind) => void;
  onMic: () => void;
  onMute: (muted: boolean) => void;
  onAnyGesture: () => void;
  /** 保存（或覆盖）当前作品；asNew 时即使已有当前作品也新建一条 */
  onSaveSong: (name: string, asNew: boolean) => void;
  onOpenSong: (id: string) => void;
  onDeleteSong: (id: string) => void;
  /** 导出单首作品为备份文件 */
  onExportSong: (id: string) => void;
  /** 从备份文件导入一首作品 */
  onImportSong: (file: File) => void;
}

const WEATHER_ICON: Record<WeatherKind, string> = { sunny: '☀️', rain: '🌧️', wind: '💨' };

/** 家长面板（HTML 覆盖层）：流速、水位、天气、录音、静音、本地作品集 */
export class Panel {
  private toastTimer: number | null = null;
  private muted = false;
  private micBtn: HTMLButtonElement;
  private muteBtn: HTMLButtonElement;

  private currentId: string | null = null;
  private currentName = '';
  private confirmTimer: number | null = null;
  private dialogMode: 'save' | 'saveAs' = 'save';

  private saveAsBtn: HTMLButtonElement;
  private currentSong: HTMLOutputElement;
  private songList: HTMLUListElement;
  private songListEmpty: HTMLElement;
  private importInput: HTMLInputElement;

  private dialog: HTMLElement;
  private nameInput: HTMLInputElement;

  constructor(private cb: PanelCallbacks) {
    const el = <T extends HTMLElement>(id: string): T => {
      const n = document.getElementById(id);
      if (!n) throw new Error(`#${id} missing`);
      return n as T;
    };

    const flow = el<HTMLInputElement>('flow');
    const level = el<HTMLInputElement>('level');
    const flowVal = el<HTMLOutputElement>('flowVal');
    const levelVal = el<HTMLOutputElement>('levelVal');
    // 实时数值提示：滑杆仍是 0~100，展示换算后的物理单位
    flow.addEventListener('input', () => {
      const raw = flow.valueAsNumber;
      flowVal.textContent = `${(raw / 50).toFixed(1)} m/s`;
      cb.onFlow(raw / 100);
    });
    level.addEventListener('input', () => {
      const raw = level.valueAsNumber;
      levelVal.textContent = `${raw} cm`;
      cb.onLevel(raw / 100);
    });

    document.querySelectorAll<HTMLButtonElement>('[data-weather]').forEach((b) =>
      b.addEventListener('click', () => cb.onWeather(b.dataset.weather as WeatherKind))
    );

    this.micBtn = el<HTMLButtonElement>('mic');
    this.micBtn.addEventListener('click', () => cb.onMic());

    this.muteBtn = el<HTMLButtonElement>('mute');
    this.muteBtn.addEventListener('click', () => {
      this.muted = !this.muted;
      this.syncMute();
      cb.onMute(this.muted);
    });

    const panel = el('panel');
    const toggle = el<HTMLButtonElement>('panelToggle');
    toggle.addEventListener('click', () => {
      const open = panel.classList.toggle('hidden') === false;
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? '收起家长面板' : '打开家长面板');
    });

    // ---------- 作品集 ----------
    this.currentSong = el<HTMLOutputElement>('currentSong');
    this.saveAsBtn = el<HTMLButtonElement>('saveAsSong');
    this.songList = el<HTMLUListElement>('songList');
    this.songListEmpty = el('songListEmpty');

    el<HTMLButtonElement>('saveSong').addEventListener('click', () => this.openDialog('save'));
    this.saveAsBtn.addEventListener('click', () => this.openDialog('saveAs'));

    // 导入：按钮转发到隐藏的文件选择框；选完清空 value，下次选同一文件仍能触发 change
    this.importInput = el<HTMLInputElement>('importFile');
    el<HTMLButtonElement>('importSong').addEventListener('click', () => this.importInput.click());
    this.importInput.addEventListener('change', () => {
      const file = this.importInput.files?.[0] ?? null;
      this.importInput.value = '';
      if (file) this.cb.onImportSong(file);
    });

    this.dialog = el('songDialog');
    this.nameInput = el<HTMLInputElement>('songNameInput');
    const form = el<HTMLFormElement>('songDialogForm');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submitDialog();
    });
    el<HTMLButtonElement>('songDialogCancel').addEventListener('click', () => this.closeDialog());
    this.dialog.addEventListener('click', (e) => {
      if (e.target === this.dialog) this.closeDialog();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.dialog.classList.contains('hidden')) this.closeDialog();
    });

    // 第一次触摸/点击时解锁 AudioContext（移动端要求）
    document.addEventListener('pointerdown', () => cb.onAnyGesture(), { once: true });
  }

  // ---------- 滑杆同步（重新打开作品时） ----------

  setFlow(v: number): void {
    const raw = Math.round(v * 100);
    const flow = document.getElementById('flow') as HTMLInputElement;
    flow.value = String(raw);
    document.getElementById('flowVal')!.textContent = `${(raw / 50).toFixed(1)} m/s`;
  }

  setLevel(v: number): void {
    const raw = Math.round(v * 100);
    const level = document.getElementById('level') as HTMLInputElement;
    level.value = String(raw);
    document.getElementById('levelVal')!.textContent = `${raw} cm`;
  }

  private syncMute(): void {
    this.muteBtn.textContent = this.muted ? '🔇' : '🔊';
    this.muteBtn.setAttribute('aria-pressed', String(this.muted));
    this.muteBtn.setAttribute('aria-label', this.muted ? '取消静音' : '静音');
  }

  setMicRecording(on: boolean): void {
    this.micBtn.classList.toggle('recording', on);
    this.micBtn.textContent = on ? '⏺️ 停止录音' : '🎙️ 录一段声音';
    this.micBtn.setAttribute('aria-pressed', String(on));
    this.micBtn.setAttribute('aria-label', on ? '停止录音' : '录一段声音');
  }

  setWeatherActive(w: WeatherKind): void {
    document
      .querySelectorAll<HTMLButtonElement>('[data-weather]')
      .forEach((b) => {
        const active = b.dataset.weather === w;
        b.classList.toggle('active', active);
        b.setAttribute('aria-pressed', String(active));
      });
  }

  setNotes(n: number, total: number): void {
    document.getElementById('noteCount')!.textContent = String(n);
    document.getElementById('noteTotal')!.textContent = String(total);
  }

  // ---------- 作品集：当前作品指示 + 列表 ----------

  setSongs(songs: SongSummary[], currentId: string | null): void {
    this.currentId = currentId;
    const current = songs.find((s) => s.id === currentId) ?? null;
    this.currentName = current?.name ?? '';
    this.currentSong.hidden = !current;
    this.currentSong.textContent = current ? `正在编辑：${current.name}` : '';
    this.saveAsBtn.hidden = !current;

    this.songList.replaceChildren(...songs.map((s) => this.renderSong(s, s.id === currentId)));
    this.songListEmpty.hidden = songs.length > 0;
  }

  private renderSong(s: SongSummary, current: boolean): HTMLElement {
    const li = document.createElement('li');
    li.className = 'song-item' + (current ? ' current' : '');

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'song-open';
    openBtn.setAttribute('aria-label', `打开《${s.name}》`);
    if (current) openBtn.setAttribute('aria-current', 'true');

    const head = document.createElement('span');
    head.className = 'song-head';
    const name = document.createElement('span');
    name.className = 'song-name';
    name.textContent = (current ? '♪ ' : '') + s.name;
    const meta = document.createElement('span');
    meta.className = 'song-meta';
    const voiceTag = s.voiceCount > 0 ? ` · 🎙️${s.voiceCount}` : '';
    meta.textContent = `${WEATHER_ICON[s.weather]} ${this.fmtTime(s.updatedAt)}${voiceTag}`;
    head.append(name, meta);
    openBtn.append(head);
    openBtn.addEventListener('click', () => this.cb.onOpenSong(s.id));

    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'song-export';
    exportBtn.setAttribute('aria-label', `导出《${s.name}》备份`);
    exportBtn.title = '导出为备份文件，可在另一台设备导入';
    exportBtn.textContent = '📤';
    exportBtn.addEventListener('click', () => this.cb.onExportSong(s.id));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'song-delete';
    delBtn.setAttribute('aria-label', `删除《${s.name}》`);
    delBtn.textContent = '🗑️';
    delBtn.addEventListener('click', () => {
      if (!delBtn.classList.contains('confirm')) {
        // 两步确认，避免家长误触删掉孩子的作品
        delBtn.classList.add('confirm');
        delBtn.textContent = '再点一次确认删除';
        if (this.confirmTimer !== null) window.clearTimeout(this.confirmTimer);
        this.confirmTimer = window.setTimeout(() => this.resetDeleteButtons(), 3000);
        return;
      }
      this.resetDeleteButtons();
      this.cb.onDeleteSong(s.id);
    });

    li.append(openBtn, exportBtn, delBtn);
    return li;
  }

  /** 取消所有删除按钮的“待确认”态（超时自动复位） */
  private resetDeleteButtons(): void {
    this.songList.querySelectorAll<HTMLButtonElement>('.song-delete.confirm').forEach((btn) => {
      btn.classList.remove('confirm');
      btn.textContent = '🗑️';
    });
  }

  private fmtTime(ts: number): string {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // ---------- 命名对话框 ----------

  private openDialog(mode: 'save' | 'saveAs'): void {
    this.dialogMode = mode;
    // 覆盖保存时沿用现名（家长可改）；另存为新歌时留空，便于起新名字
    this.nameInput.value = mode === 'save' ? this.currentName : '';
    this.dialog.classList.remove('hidden');
    // 下一帧再聚焦，iOS Safari 对 display 切换当帧聚焦支持不好
    window.setTimeout(() => {
      this.nameInput.focus();
      this.nameInput.select();
    }, 30);
  }

  private closeDialog(): void {
    this.dialog.classList.add('hidden');
  }

  private submitDialog(): void {
    const name = this.nameInput.value.trim() || `河流之歌 ${this.fmtTime(Date.now())}`;
    this.closeDialog();
    this.cb.onSaveSong(name, this.dialogMode === 'saveAs');
  }

  toast(msg: string): void {
    const t = document.getElementById('toast')!;
    t.textContent = msg;
    t.classList.add('show');
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => t.classList.remove('show'), 2600);
  }
}
