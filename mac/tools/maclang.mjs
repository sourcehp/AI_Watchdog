// Windows용 언어 파일(tools/win-lang)을 맥용(Resources/lang)으로 바꿈.
// 사용: node tools/maclang.mjs   (새 언어는 win-lang 에 넣고 다시 실행하거나, 맥용 형식으로 바로 Resources/lang 에 넣어도 됨)
import fs from 'node:fs';
const src = new URL('./win-lang/', import.meta.url);
const out = new URL('../Resources/lang/', import.meta.url);
// 맥 전용 새 문구: tools/mac-extra.json { 언어코드: { 키: 문구 } }
const EXTRA = JSON.parse(fs.readFileSync(new URL('./mac-extra.json', import.meta.url), 'utf8'));

// 맥에 없는 기능(최대 절전, 프로세스별 GPU, 창 내리기, 중복 실행 질문)
const DROP = ['x.tip.min', 'act.word.4', 'act.phrase.4', 'hero.pending.4', 'rest.auto.4', 'err.hibOff', 'err.hibFail',
  'c.alreadyAsk', 'x.gpu', 'x.gpuHint', 'gpu.noHint'];

const O = {
  en: {
    'x.tip.close': 'Close window (keeps watching from the menu bar)',
    'x.startup': 'Open at login', 'x.startupHint': 'Starts quietly in the menu bar',
    'x.appearanceHint': 'Light, dark, or follow macOS',
    'c.already': 'AI Watchdog is already running. Open it from the menu bar icon.',
    'tray.hidden': 'Still watching from the menu bar. Choose Quit from the icon menu to stop.',
    'hero.noHold': 'Keep-awake is off, so the Mac may sleep as usual.',
    'rest.windows': 'The Mac follows your macOS sleep settings.',
    'x.tgSecure': 'The token is stored in your macOS Keychain.',
    'mode.tip': 'By usage: counts as working only while it uses CPU.\nWhile open: counts as working the whole time it runs.\nClick to switch.',
  },
  ko: {
    'x.tip.close': '창 닫기 (메뉴 막대에서 계속 지켜봐요)',
    'x.startup': '로그인할 때 함께 실행', 'x.startupHint': '창 없이 메뉴 막대에서 조용히 시작해요',
    'x.appearanceHint': '밝게, 어둡게 또는 macOS 설정을 따라가요',
    'c.already': 'AI Watchdog가 이미 실행 중이에요. 메뉴 막대 아이콘을 눌러 여세요.',
    'tray.hidden': '메뉴 막대에서 계속 지켜보고 있어요. 완전히 끄려면 아이콘 메뉴에서 종료를 고르세요.',
    'hero.noHold': '절전 방지가 꺼져 있어 macOS 설정대로 잠들 수 있어요.',
    'rest.windows': 'Mac은 macOS 절전 설정대로 동작해요.',
    'x.tgSecure': '토큰은 macOS 키체인에 저장해요.',
    'mode.tip': '사용량 기준: CPU를 쓸 때만 작업 중으로 봐요.\n켜져 있으면: 프로그램이 켜져 있는 동안 계속 작업 중으로 봐요.\n눌러서 바꿀 수 있어요.',
  },
  ja: {
    'x.tip.close': 'ウィンドウを閉じる（メニューバーで監視を続けます）',
    'x.startup': 'ログイン時に起動', 'x.startupHint': 'ウィンドウなしでメニューバーから静かに起動',
    'x.appearanceHint': 'ライト、ダーク、または macOS に合わせる',
    'c.already': 'AI Watchdog はすでに実行中です。メニューバーのアイコンから開いてください。',
    'tray.hidden': 'メニューバーで監視を続けています。終了するにはアイコンのメニューから「終了」を選んでください。',
    'hero.noHold': 'スリープ防止がオフなので、macOS の設定どおりスリープすることがあります。',
    'rest.windows': 'Mac は macOS のスリープ設定に従います。',
    'x.tgSecure': 'トークンは macOS のキーチェーンに保存します。',
    'mode.tip': '使用率で判断: CPU を使っている間だけ作業中とみなします。\n起動中は常に: 起動している間ずっと作業中とみなします。\nクリックで切り替えます。',
  },
  zh: {
    'x.tip.close': '关闭窗口（在菜单栏中继续监控）',
    'x.startup': '登录时启动', 'x.startupHint': '在菜单栏中静默启动',
    'x.appearanceHint': '浅色、深色或跟随 macOS',
    'c.already': 'AI Watchdog 已在运行。请点击菜单栏图标打开。',
    'tray.hidden': '仍在菜单栏中监控。要退出，请在图标菜单中选择“退出”。',
    'hero.noHold': '保持唤醒已关闭，Mac 可能按 macOS 设置睡眠。',
    'rest.windows': 'Mac 按 macOS 睡眠设置运行。',
    'x.tgSecure': '令牌保存在 macOS 钥匙串中。',
    'mode.tip': '按使用率：仅在占用 CPU 时视为工作。\n运行即算：程序运行期间一直视为工作。\n点击可切换。',
  },
  es: {
    'x.tip.close': 'Cerrar ventana (sigue vigilando desde la barra de menús)',
    'x.startup': 'Abrir al iniciar sesión', 'x.startupHint': 'Se inicia en la barra de menús sin ventana',
    'x.appearanceHint': 'Claro, oscuro o como macOS',
    'c.already': 'AI Watchdog ya se está ejecutando. Ábrelo desde el icono de la barra de menús.',
    'tray.hidden': 'Sigue vigilando desde la barra de menús. Elige Salir en el menú del icono para cerrarlo.',
    'hero.noHold': 'Mantener activo está desactivado; el Mac puede suspenderse como siempre.',
    'rest.windows': 'El Mac sigue la configuración de suspensión de macOS.',
    'x.tgSecure': 'El token se guarda en el Llavero de macOS.',
    'mode.tip': 'Según uso: cuenta como trabajo solo mientras usa CPU.\nMientras esté abierta: cuenta como trabajo todo el tiempo.\nHaz clic para cambiar.',
  },
  vi: {
    'x.tip.close': 'Đóng cửa sổ (vẫn theo dõi từ thanh menu)',
    'x.startup': 'Mở khi đăng nhập', 'x.startupHint': 'Khởi động lặng lẽ ở thanh menu',
    'x.appearanceHint': 'Sáng, tối hoặc theo macOS',
    'c.already': 'AI Watchdog đang chạy. Hãy mở từ biểu tượng trên thanh menu.',
    'tray.hidden': 'Vẫn đang theo dõi trên thanh menu. Chọn Thoát trong menu biểu tượng để tắt.',
    'hero.noHold': 'Giữ máy thức đang tắt nên Mac có thể ngủ như bình thường.',
    'rest.windows': 'Mac hoạt động theo cài đặt ngủ của macOS.',
    'x.tgSecure': 'Token được lưu trong Chuỗi khóa của macOS.',
    'mode.tip': 'Theo mức dùng: chỉ tính là làm việc khi dùng CPU.\nKhi đang mở: luôn tính là làm việc khi ứng dụng chạy.\nNhấn để đổi.',
  },
  th: {
    'x.tip.close': 'ปิดหน้าต่าง (ยังเฝ้าดูจากแถบเมนู)',
    'x.startup': 'เปิดเมื่อเข้าสู่ระบบ', 'x.startupHint': 'เริ่มทำงานเงียบๆ ในแถบเมนู',
    'x.appearanceHint': 'สว่าง มืด หรือตาม macOS',
    'c.already': 'AI Watchdog ทำงานอยู่แล้ว เปิดจากไอคอนในแถบเมนู',
    'tray.hidden': 'ยังเฝ้าดูอยู่ในแถบเมนู เลือก ออก จากเมนูของไอคอนเพื่อปิด',
    'hero.noHold': 'ปิดการเปิดค้างไว้อยู่ Mac อาจสลีปตามปกติ',
    'rest.windows': 'Mac ทำงานตามการตั้งค่าสลีปของ macOS',
    'x.tgSecure': 'โทเคนถูกเก็บไว้ในพวงกุญแจของ macOS',
    'mode.tip': 'ตามการใช้งาน: ถือว่าทำงานเฉพาะเมื่อใช้ CPU\nขณะเปิดอยู่: ถือว่าทำงานตลอดเวลาที่เปิด\nคลิกเพื่อสลับ',
  },
};

// "PC" → "Mac" (한국어는 조사도 맞춤: 맥 = 받침 있음)
function toMac(code, s) {
  if (code === 'ko') {
    return s.replace(/PC를/g, 'Mac을').replace(/PC가/g, 'Mac이').replace(/PC는/g, 'Mac은')
            .replace(/PC로/g, 'Mac으로').replace(/PC/g, 'Mac');
  }
  return s.replace(/\bPC\b/g, 'Mac');
}

for (const file of fs.readdirSync(src).filter(f => f.endsWith('.json'))) {
  const doc = JSON.parse(fs.readFileSync(new URL(file, src), 'utf8'));
  const strings = {};
  for (const [k, v] of Object.entries(doc.strings)) if (!DROP.includes(k)) strings[k] = toMac(doc.code, v);
  Object.assign(strings, O[doc.code] || O.en);
  Object.assign(strings, EXTRA.en, EXTRA[doc.code] || {});     // 맥에서 새로 생긴 기능(시스템·팬·토큰)
  const outDoc = { code: doc.code, name: doc.name, order: doc.order, culture: doc.culture, strings };
  fs.writeFileSync(new URL(file, out), JSON.stringify(outDoc, null, 1) + '\n');
  console.log('wrote', file, Object.keys(strings).length, 'strings');
}
