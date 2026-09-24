// Все пороги и тюнинг. Персональные значения — в CalibrationProfile (input/calibration.ts).
// Помечено «M0» — подобрать по живым фикстурам, текущие значения — разумные дефолты, не замеры.

export type LidCombine = 'min' | 'mean' | 'max' | 'L' | 'R';
export type EyeSignal = 'blendshape' | 'iris';

export const config = {
  tracker: {
    targetHz: 30,
    video: { width: 640, height: 480, frameRate: 30 },
    delegate: 'GPU' as 'GPU' | 'CPU',
    modelPath: 'mediapipe/face_landmarker.task',
    wasmPath: 'mediapipe/wasm',
    lumaEveryNFrames: 5,
    lumaSize: { w: 32, h: 24 },
    // Трекер и рендер делят кадр: при просадке рендера снижаем частоту трекинга (CLAUDE.md → Грабли).
    adaptive: { minHz: 15, lowFps: 50, highFps: 57, stepHz: 5, holdMs: 2000 },
  },

  signal: {
    // confidence = лицо найдено × smoothstep(lumaLow, lumaOk, яркость лица)
    lumaLow: 0.05, // M0
    lumaOk: 0.12, // M0
    lostBelow: 0.5,
    backAbove: 0.6,
    lostAfterMs: 250,
    backAfterMs: 500,
  },

  lid: {
    // min: сомкнуты оба глаза. Ложное моргание хуже пропущенного (TECH → Сигналы). M0
    combine: 'min' as LidCombine,
    // Пороги по нормированному score: 0 = открыты (калибровка), 1 = закрыты.
    onThreshold: 0.55, // M0
    offThreshold: 0.35, // M0
    // Каждый кадр сверх 1 — +1 кадр латентности blinkStart.
    confirmFrames: 1,
    closedMsDefault: 500,
    closedMsRange: [350, 900] as const,
    closedMsPerBlink: 2.5, // closedMs = медиана моргания × k, в пределах closedMsRange
    squintFrom: 0.15, // M0: начало полосы прищура по среднему score
    // Пороги из шума: on ≥ open + k·σ (в нормированных единицах), в пределах диапазонов.
    noiseSigmaOn: 6,
    noiseSigmaOff: 3,
    onRange: [0.4, 0.8] as [number, number],
    offRange: [0.2, 0.6] as [number, number],
    // Baseline открытых глаз догоняет свет и усталость; только пока веки уверенно открыты.
    noisyConfirmSigma: 0.1, // σ нормированного сигнала выше — подтверждать моргание 2 кадрами (+1 кадр латентности)
    baselineTauMs: 20_000,
    baselineMaxDrift: 0.5, // доля от (закрыты − открыты при калибровке)
    winkAsym: 0.4,
    winkMinMs: 150,
    swapLR: false, // M0: true, если eyeBlinkLeft оказался правым глазом игрока
  },

  gaze: {
    eyeSignal: 'blendshape' as EyeSignal, // M0: сравнить с 'iris'
    headWeight: 3, // M0: вклад прокси поворота головы (единицы — доля ширины лица)
    eyeWeight: 1, // M0
    calibTarget: 2 / 3, // калибровочные точки в центрах зон L/R и U/D
    oneEuro: { minCutoff: 1.0, beta: 0.3, dCutoff: 1.0 }, // M0
    holdAfterShutMs: 120,
  },

  zones: {
    boundary: 1 / 3,
    hysteresis: 0.08, // M0
    dwellMs: 120, // M0
  },

  wide: { from: 0.1, to: 0.6 }, // M0

  fallback: {
    blinkMs: 150,
    zoneDwellMs: 0,
    // Непроизвольные моргания без камеры: иначе на клавиатуре моргаешь только когда выгодно,
    // а «моргание нельзя отменить» — столп GDD. 0 — выключить (доступность).
    autoBlinkPerMin: 10,
  },

  calibration: {
    settleMs: 600, // не брать кадры в начале шага: глаза ещё едут
    stepMs: 1800,
    blinkCount: 5,
    blinkStepMs: 6500,
    closedStepMs: 2500,
    // v2: 9 точек сеткой 3×3 на ±gridAt, приём по стабильности взгляда.
    gridAt: 0.75,
    validateAt: 0.4, // точки валидации (±, ±)
    stableWindow: 8, // кадров в окне стабильности
    stableStd: 0.05, // M0: макс. СКО сырых осей в окне (саккада ≫ шум)
    minStableFrames: 14,
    pointTimeoutMs: 3500,
    ridgeLambda: 0.02,
    maxValidationError: 0.25, // хуже — предложить повтор
    checkMs: 3500, // живая проверка курсором после калибровки
    minFramesPerStep: 5,
    minSeparation: 0.2, // закрытые − открытые, иначе профиль не принимается (очки, блики)
    minGazeSpan: 0.03, // M0: минимальный сырой размах L/R от центра, иначе профиль не принимается
    storageKey: 'lookaway.profile.v1',
  },

  // Критерии автоматического отчёта evaluate() для фикстур протоколов.
  acceptance: {
    blinkWindowMs: 1000,
    blinkRecall: 0.9,
    blinkExtraMax: 3,
    zoneCheckAfterMs: 1200,
    zoneAccuracy: 0.9,
    zoneChangeMaxRatio: 1.5,
    closeWindowExtraMs: 1000,
    lostWindowMs: 1500,
  },

  debug: {
    graphSeconds: 6,
  },

  game: {
    simHz: 60, // фиксированный шаг симуляции (TECH → Директор)
    maxFrameMs: 250, // вкладка спала — не догонять симуляцию рывком
  },

  // v2: процедурная долина (GDD → Мир).
  world: {
    radius: 105, // м, проходимая часть долины
    spawnClearing: 12, // м, поляна вокруг маяка
    hillHeight: 7,
    rimHeight: 30, // обрыв по краю
    variantsPerSpecies: 3, // разных мешей на вид (инстансы вращаются и масштабируются)
    rockCount: 140,
    treeCell: 5,
    treeDensity: 0.5,
    fernCell: 3,
    fernDensity: 0.28,
    flowerClusters: 26,
    fungusPatches: 40,
    grassCell: 1.7,
    grassDensity: 0.45,
    logCount: 50,
    stumpCount: 30,
    shrubCell: 3.5,
    shrubDensity: 0.3,
    pebbleCount: 700,
    animalsPerSpecies: 9,
    darkMinDist: 70, // чёрная материя появляется не ближе
    terrainStep: 1, // м, шаг сетки рельефа
    tileSize: 40, // м, тайл слитой статики (отсечение при снимке)
  },

  // v2: чёрная материя (GDD → Чёрная материя).
  dark: {
    radius: 1.1,
    hearing: 80, // м: слышит импульс
    senseRadius: 8, // м: ближе — идёт прямо на игрока
    speed: 1.25, // м/с (игрок идёт 2.2)
    driftMul: 0.35, // без цели медленно дрейфует к игроку
    closedMul: 2, // пока глаза закрыты
    blinkLeap: 1.5, // м, рывок на моргании
    safeDist: 4, // рывок не подводит ближе (моргание не убивает)
    killDist: 1.4,
    holdMaxMs: 4000, // держать взглядом не дольше
    holdResetMs: 2000, // отвёл взгляд на столько — «привыкание» сброшено
    gazeHoldAngle: 0.21, // рад (~12°) между взглядом и направлением на неё
  },

  fauna: {
    fleeRadius: 15, // м: пугливые разлетаются от импульса
  },

  research: {
    studyMs: 7000, // детальный скан: три прохода
    documentGoal: 6, // видов до эвакуации
    reachPlant: 2.0, // м
    reachAnimal: 1.6, // м до настоящей позиции насекомого
    extractRadius: 3, // м от маяка
    specimenPoints: 60_000, // точек в детальном скане
  },

  // v2: лидар (GDD → Лидар). Точек на скан — главный рычаг производительности.
  lidar: {
    points: 280_000,
    channels: 300, // каналов по углу места (кольца на земле)
    horizonBias: 0.55, // 0 — каналы равномерно, 1 — всё у горизонта
    cubeSize: 512, // грань кубической карты глубины: 0.18° на пиксель
    waveSpeed: 42, // м/с, фронт волны
    persistMs: 14_000, // сколько живёт облако без морганий
    fadeFrom: 0.65, // доля persistMs, после которой облако растворяется
    maxScans: 3,
    blinkErase: 0.35, // доля оставшихся точек, которую стирает одно моргание
    pointFill: 0.85, // пятно луча в долях углового шага (<1 — видны промежутки)
    gain: 2.0, // усиление интенсивности возврата
    maxPointPx: 3.5, // CSS-пикс.
    edlStrength: 0.9,
    edlRadius: 1.4, // CSS-пикс.
    edlFloor: 0.42, // точка за краем темнеет не ниже этой доли
    lensAngle: 0.22, // рад: радиус линзирования вокруг чёрной материи
    lensStrength: 1.4, // м: насколько тянет точки к центру
  },

  // Импульс — закрыть глаза и открыть (GDD → Основной цикл). Дольше закрыты — дальше скан.
  scanner: {
    cooldownMs: 6000,
    closedRechargeMul: 2, // с закрытыми глазами заряжается быстрее
    holdFullMs: 2500, // столько держать глаза закрытыми (после closedMs) до полной дальности
    rangeMin: 18, // м: короткое зажмуривание
    rangeMax: 36, // м: полное
    rangePerSpecies: 1.5, // м за каждый описанный вид: сканер калибруется под местную среду
    firstPower: 0.6, // мощность первого, автоматического импульса
  },

  player: {
    eyeHeight: 1.6,
    walk: 2.2, // м/с
    run: 3.8,
    radius: 0.35,
    mouseSens: 0.0022,
    keyTurn: 0.035, // рад за кадр стрелками
  },

  // Режим B (GDD → Управление): всё глазами. Эксперимент.
  handsFree: {
    edge: 0.7, // |gaze.x| дальше — поворот
    turn: 0.03, // рад за кадр на краю
    edgeY: 0.8,
    look: 0.012,
    dwellMs: 1500, // взгляд в центре при подсказке — взять образец / эвакуация
    dwellRadius: 0.3,
  },
};

export type Config = typeof config;
