// English is the native language of the codebase and the default UI language —
// every string is written in English directly at the call site as the fallback.
// Ukrainian is an optional overlay: only entries that exist here get swapped in
// when the user picks "UK". Anything missing from this table silently falls back
// to the English text already baked into the code, so there's no risk of a blank
// label if a translation is missing.
export type Lang = 'en' | 'uk';

const UK: Record<string, string> = {
  'app.title': 'Mova Flow',
  'app.tagline': 'Локальна транскрипція на основі Whisper',
  'nav.upload': 'Завантаження',
  'nav.history': 'Історія',
  'nav.server': 'Сервер',
  'lang.switch.label': 'Мова інтерфейсу',
  'nav.record': 'Запис',
  'nav.settings': 'Налаштування',
  'record.title': 'Запис дзвінка',
  'settings.title': 'Налаштування',
  'settings.recording': 'Запис',
  'settings.language': 'Мова',
  'settings.language.busy': 'Мову не можна змінити, поки йде запис дзвінка.',
  'settings.updates': 'Оновлення',
  'settings.vocab': 'Словник',
  'vocab.terms': 'Терміни',
  'vocab.terms.hint': 'Назви й терміни, які звучать у твоїх записах, через кому або з нового рядка. Whisper чекатиме саме на них.',
  'vocab.replacements': 'Автозаміни',
  'vocab.replacements.hint': 'Одна на рядок: як почулось → як має бути. Застосовуються до кожної готової розшифровки, лише цілі слова.',
  'vocab.useHost': 'Також використовувати словник хоста',
  'vocab.hostNote': 'На цьому хості словник застосовується і до записів, які надсилають клієнти.',
  'vocab.saved': 'Збережено.',
  'correct.tip': 'Двічі клацни на слові або виділи фразу, щоб виправити',
  'correct.remember': 'Запам’ятати для наступних записів',
  'correct.replace': 'Замінити',
  'correct.cancel': 'Скасувати',
  'correct.done': 'Замінено: {n}',
  'correct.notSaved': 'не збережено в історії',
  'correct.remembered': 'запам’ятано в словнику',
  'rec.mic.hint': 'Цим мікрофоном записується твоя сторона дзвінка у вкладці «Запис».',
  'rec.mic.change': 'змінити',
  'rec.mic.headset': '— навушники перейдуть у режим гарнітури',

  'banner.checking': 'Перевірка компонентів розпізнавання...',
  'banner.installing': 'Встановлення компонентів розпізнавання...',
  'banner.starting': 'Запуск сервера...',
  'banner.off': 'Сервер вимкнено. Перейди на вкладку «Сервер» і натисни «Старт».',

  'drop.label': 'Перетягни аудіофайл сюди, або клікни щоб обрати',
  'rec.start': 'Записати дзвінок',
  'rec.stop': 'Зупинити й розпізнати',
  'rec.starting': 'Запускаю...',
  'rec.stopping': 'Зупиняю...',
  'rec.source.all': 'Увесь звук системи',
  'rec.from': 'з {name}',
  'rec.from.all': 'увесь звук системи',
  'picker.title': 'Звідки записувати звук дзвінка?',
  'picker.sub': 'Обери програму, в якій іде дзвінок, — тоді сповіщення, музика й інші програми не потраплять у запис.',
  'picker.refresh': 'Оновити',
  'picker.cancel': 'Скасувати',
  'picker.record': 'Записати',
  'picker.playing': 'грає',
  'picker.noThumbs':
    'Щоб бачити мініатюри вікон, дозволь Mova Flow у Системних параметрах → Приватність і безпека → Запис екрана та системного аудіо. Запис працює так само й без них.',
  'rec.mic': 'Мікрофон',
  'rec.mic.default': 'Системний за замовчуванням',
  'rec.mic.defaultNamed': 'Системний за замовчуванням ({name})',
  'rec.mic.bluetooth':
    'Bluetooth-мікрофон перемикає навушники в режим гарнітури на час запису — дзвінок у вухах звучатиме гірше. Вбудований мікрофон цього не робить.',
  'rec.me': 'Я',
  'rec.call': 'Дзвінок',
  'rec.hint':
    'Записує твій мікрофон і все, що грає цей комп’ютер — дзвінок у Zoom, Teams чи Telegram — і позначає, хто що сказав. У навушниках розділення найточніше.',
  'rec.err.start': 'Не вдалося почати запис.',
  'transcribe.language': 'Мова:',
  'transcribe.language.auto': 'Автовизначення',
  'transcribe.language.uk': 'Українська',

  'job.queued': 'У черзі',
  'job.processing': 'Обробка',
  'job.done': 'Готово',
  'job.error': 'Помилка',
  'job.uploading': 'Надсилаю файл...',
  'job.converting': 'Конвертую формат...',
  'job.copy': 'Копіювати',
  'job.copied': 'Скопійовано',
  'job.download': 'Завантажити .txt',
  'job.err.decode': 'Не вдалося декодувати аудіо в цьому форматі.',
  'job.err.unreachable': "Не вдалося зв'язатися з сервером.",
  'job.err.lostConnection': "Втрачено зв'язок із сервером",
  'job.err.unknown': 'Невідома помилка',
  'job.retry': 'Спробувати ще раз',
  'job.showFile': 'Показати файл',
  'job.savedRecording': 'Запис збережено — він чекатиме в Історії, доки його не розпізнають.',
  'job.busyRetry': 'Сервер зайнятий — зараз спробую ще раз...',
  'rec.pending.send': 'Розпізнати',

  'history.title': 'Історія',
  'history.empty': 'Ще немає жодної транскрипції.',
  'history.language': 'Мова: {lang}',
  'history.play': 'Відтворити',
  'history.loading': 'Завантаження...',
  'history.viewText': 'Показати текст',
  'history.hideText': 'Сховати текст',
  'history.delete': 'Видалити',
  'history.delete.confirm': 'Видалити цей запис і його транскрипцію? Це незворотно.',
  'history.retranscribe': 'Розпізнати ще раз',
  'history.pending.recording': 'Іде запис',
  'history.pending.sending': 'Розпізнається...',
  'history.pending.notYet': 'Не розпізнано',
  'history.pending.interrupted': 'відновлено після того, як програма закрилася під час запису',
  'history.pending.deleteConfirm': 'Видалити цей запис? Його ще не розпізнано, і це незворотно.',

  'server.title': 'Сервер',
  'role.host.title': 'Сервер (host)',
  'role.host.desc': 'Ця машина тримає модель і обробляє транскрипцію (GPU бажаний, але не обов\'язковий).',
  'role.client.title': 'Клієнт',
  'role.client.desc': 'Тільки інтерфейс, підключення до іншої машини в мережі.',
  'field.port': 'Порт',
  'model.select.label': 'Модель Whisper',
  'model.select.hint': 'Більші моделі точніші, але повільніші й довше завантажуються.',
  'model.path.hint': 'Або використай власний файл моделі замість завантаження:',
  'model.path.placeholder': 'Файл не обрано',
  'model.browse': 'Огляд...',
  'model.clear': 'Скинути',
  'srv.stopped': 'Зупинено',
  'srv.checking': 'Перевірка...',
  'srv.installing': 'Встановлення...',
  'srv.starting': 'Запуск...',
  'srv.running': 'Працює',
  'srv.error': 'Помилка',
  'srv.start': 'Старт',
  'srv.stop': 'Стоп',
  'srv.lanUrl': 'Доступно в мережі: {url}',
  'srv.localOnly': 'Доступно лише на цьому комп’ютері.',
  'lan.expose.label': 'Доступ з локальної мережі',
  'lan.expose.hint':
    'Дозволяє іншим пристроям у мережі підключатись до цього сервера. Вимкни, щоб користуватись лише на цьому комп’ютері.',

  'secret.label': 'Секретний ключ доступу',
  'secret.hint':
    'Потрібен на кожному клієнтському пристрої, щоб він міг підключитись до цього сервера по мережі. Без нього API транскрипції недоступне нікому.',
  'secret.copy': 'Копіювати',
  'secret.regen': 'Згенерувати новий',
  'secret.regen.confirm':
    'Перегенерувати секрет? Усі клієнти, підключені зі старим ключем, втратять доступ, доки не введуть новий.',

  'client.host.label': 'IP-адреса сервера',
  'client.secret.label': 'Секретний ключ (з вкладки «Сервер» на host-машині)',
  'client.secret.placeholder': 'секретний ключ',
  'client.save': 'Зберегти',
  'client.check': 'Перевірити з’єднання',
  'client.checking': 'Перевіряю...',
  'client.saved': 'Збережено.',
  'client.unreachable': 'Сервер не відповідає.',
  'client.unreachable.detail': 'Сервер не відповідає: {error}',
  'client.badSecret': "З'єднання є, але секретний ключ невірний.",
  'client.ok': "З'єднання успішне, авторизація пройшла.",
  'client.scan': 'Знайти в мережі',
  'client.scanning': 'Пошук...',
  'client.scan.empty': 'Нічого не знайдено — введи хост вручну нижче.',
  'client.scan.hint': 'Знаходить хости з увімкненим "Доступ з локальної мережі".',

  'update.available': 'Доступна Mova Flow {version}.',
  'update.download': 'Завантажити',
  'update.downloading': 'Завантажую Mova Flow {version}... {percent}%',
  'update.downloaded': 'Mova Flow {version} готова до встановлення.',
  'update.restart': 'Перезапустити й оновити',
  'update.downloadFailed': 'Не вдалося завантажити Mova Flow {version}: {error}',
  'update.retry': 'Спробувати ще раз',

  'about.version': 'Mova Flow v{version}',
  'about.checkUpdates': 'Перевірити оновлення',
  'about.checking': 'Перевіряю...',
  'about.upToDate': 'Встановлена остання версія — v{version}',
  'about.checkFailed': 'Не вдалося перевірити оновлення: {error}',
  'about.autoUpdate': 'Оновлювати автоматично',
  'about.autoUpdate.hint':
    'Завантажує нові версії у фоні й пропонує перезапуститися, коли все готово. Вимкнено — ти отримуєш повідомлення й сам вирішуєш, коли завантажувати.',
};

let currentLang: Lang = 'en';

export function setLang(lang: Lang): void {
  currentLang = lang;
}

export function getLang(): Lang {
  return currentLang;
}

/** `fallback` is the real English string, written inline at every call site —
 * `t()` only ever substitutes it when the active language has an override. */
export function t(key: string, fallback: string, vars?: Record<string, string>): string {
  const raw = currentLang === 'uk' && key in UK ? UK[key] : fallback;
  if (!vars) return raw;
  return Object.entries(vars).reduce((acc, [name, value]) => acc.replaceAll(`{${name}}`, value), raw);
}
