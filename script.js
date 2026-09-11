// ============================================================
// HỆ THỐNG GIÁM SÁT VÀ CẢNH BÁO LŨ - Giai đoạn 4: Đa trạm + Trang chủ
// ============================================================
// File này thay thế hoàn toàn script-new.js (Giai đoạn 3) để hỗ trợ
// 3 trạm (Trạm 1, Trạm 2, Trạm 3) và một Trang chủ tổng quan.
//
// ------------------------------------------------------------
// THAY ĐỔI CẤU TRÚC FIREBASE (QUAN TRỌNG - CẦN CẬP NHẬT ESP32)
// ------------------------------------------------------------
// Bản gốc chỉ có 1 trạm nên ESP32 ghi thẳng vào:
//   FloodSystem, Measurement, Configuration
// Với 3 trạm, mỗi trạm cần một nhánh dữ liệu RIÊNG để không bị trộn
// dữ liệu. Cấu trúc mới:
//   Stations/<stationId>/FloodSystem      (giống FloodSystem cũ)
//   Stations/<stationId>/Measurement      (giống Measurement cũ)
//   Stations/<stationId>/Configuration    (giống Configuration cũ)
//   WebSettings/<stationId>               (mực nước tham chiếu + 3 ngưỡng,
//                                           node CHỈ WEB DÙNG, ESP32 không đọc)
// stationId nhận giá trị: "station-1", "station-2", "station-3".
//
// => ESP32 của Trạm 1 (DoAn2_ESP32_Firebase.ino) CẦN SỬA lại đường dẫn
//    ghi Firebase từ "FloodSystem/..." thành "Stations/station-1/FloodSystem/...”
//    (tương tự cho Measurement, Configuration) để khớp với cấu trúc mới.
//    Trạm 2 và Trạm 3 hiện CHƯA có ESP32 thật, khi lắp đặt sau này cũng
//    ghi theo đúng mẫu "Stations/station-2/..." / "Stations/station-3/...".
//
// GHI CHÚ QUAN TRỌNG VỀ PHẦN CỨNG (giữ nguyên từ bản gốc, áp dụng cho
// từng trạm riêng biệt khi có ESP32 thật):
//  - Chỉ "Cảnh báo mức 3" (SOS) mới thực sự điều khiển ESP32 của trạm đó:
//    giá trị này được quy đổi ngược ra "khoảng cách cảm biến" rồi ghi
//    xuống đúng field Stations/<stationId>/FloodSystem/WarningLevel, để
//    ESP32 tiếp tục tự gửi SMS/gọi điện khi vượt ngưỡng.
//  - "Cảnh báo mức 1" và "mức 2" CHỈ đổi màu/trạng thái hiển thị trên
//    web, không ảnh hưởng phần cứng.
//  - Trạm 2 và Trạm 3 hiện CHƯA có ESP32 thật -> hiển thị "chưa kết nối",
//    vô hiệu hoá các ô nhập/nút SET khi đang xem các trạm này.
//
// ------------------------------------------------------------
// KHÁI NIỆM "MỰC NƯỚC THAM CHIẾU" VÀ "MỨC NƯỚC DÂNG"
// ------------------------------------------------------------
// Mỗi trạm có một "mực nước tham chiếu" riêng (trước đây gọi là "mức
// nước ban đầu") vì vị trí lắp đặt/điều kiện thực tế từng trạm khác
// nhau. Toàn bộ biểu đồ, thẻ chỉ số và ước tính tốc độ truyền lũ đều
// làm việc trên "mức nước dâng" = mực nước tham chiếu - khoảng cách đo
// hiện tại (khoảng cách càng nhỏ = nước càng dâng), KHÔNG dùng khoảng
// cách thô để so sánh chéo giữa các trạm.
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
    getDatabase,
    ref,
    onValue,
    update,
    get,
    set,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js";

// ------------------------------------------------------------
// Firebase config - GIỮ NGUYÊN như bản gốc (không đổi project Firebase)
// ------------------------------------------------------------
const firebaseConfig = {
    apiKey: "AIzaSyCy37cWboOIIxPN0_LvnZiefjDq1Z5coEw",
    authDomain: "flood-iot-9bd06.firebaseapp.com",
    databaseURL: "https://flood-iot-9bd06-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "flood-iot-9bd06",
    storageBucket: "flood-iot-9bd06.firebasestorage.app",
    messagingSenderId: "999141864715",
    appId: "1:999141864715:web:0baa1905357397afd55e0e",
    measurementId: "G-BG54YREV5D",
};

const app = initializeApp(firebaseConfig);
const database = getDatabase(app);
const connectedRef = ref(database, ".info/connected");

// ------------------------------------------------------------
// HẰNG SỐ
// ------------------------------------------------------------
// Firebase RTDB giờ chỉ đóng vai trò BỘ ĐỆM GẦN ĐÂY (không cần giữ mãi
// mãi) - dữ liệu ĐẦY ĐỦ, KHÔNG GIỚI HẠN được sao lưu song song sang Google
// Sheets (xem "SAO LƯU DỮ LIỆU DÀI HẠN SANG GOOGLE SHEETS" bên dưới). Giữ
// 200 bản ghi/trạm là đủ cho biểu đồ "24 giờ" ngay cả ở chu kỳ đo nhanh
// nhất hiện tại (15s/lần khi test) mà vẫn cách xa giới hạn dung lượng của
// gói Firebase free (1GB).
const MAX_MEASUREMENTS = 200;
const CLIENT_HISTORY_LIMIT = 500; // số điểm tối đa giữ trong bộ nhớ trình duyệt để vẽ biểu đồ/dự đoán/ước tính tốc độ truyền lũ

// Trạm 1 dùng SENSOR_INTERVAL=15s (chế độ test) trong code ESP32 hiện tại.
// Nếu sau này đổi ESP32 sang chu kỳ thật (30 phút), PHẢI tăng hằng số này
// tương ứng (ví dụ 2 * 30 * 60 * 1000), nếu không hệ thống sẽ báo "Mất kết
// nối" sai dù ESP32 vẫn hoạt động bình thường.
const STALE_MS = 90 * 1000; // quá 90s không có dữ liệu mới -> coi là mất kết nối/dữ liệu cũ

const MIN_HARDWARE_THRESHOLD = 0.05; // ngưỡng khoảng cách tối thiểu hợp lệ gửi cho ESP32 (m)

const DEFAULT_INITIAL_LEVEL = 0.5;
const DEFAULT_ALERT_LEVELS = { level1: 0.5, level2: 0.8, level3: 1.0 };
const DEFAULT_DISTANCES = { "1-2": 5.0, "2-3": 7.0 }; // km - chỉnh được trên giao diện, không hard-code cố định

// ------------------------------------------------------------
// PHÁT HIỆN TỰ ĐỘNG "THỜI ĐIỂM BẮT ĐẦU DÂNG" (thay cho ngưỡng mức dâng
// cố định do người dùng nhập trước đây - xem detectRiseStartEvent()).
// ------------------------------------------------------------
// Độ dốc tối thiểu (m/phút) để coi một chuỗi điểm đo là "đang dâng thật
// sự", không phải nhiễu đo đạc của cảm biến siêu âm. Độ nhạy "trung
// bình": đủ thấp để bắt được các đợt dâng vừa phải, đủ cao để không báo
// nhầm do sai số cảm biến (thường dao động vài mm quanh giá trị thật).
const RISE_START_MIN_SLOPE_PER_MIN = 0.02;
// Số điểm đo liên tiếp (kể cả điểm bắt đầu) phải cùng cho thấy xu hướng
// dâng thì mới chấp nhận đó là khởi đầu một đợt dâng thật.
const RISE_START_MIN_CONSECUTIVE_POINTS = 3;

const RANGE_MS = {
    "6h": 6 * 3600 * 1000,
    "12h": 12 * 3600 * 1000,
    "24h": 24 * 3600 * 1000,
    "7d": 7 * 24 * 3600 * 1000,
};

const HORIZON_LABEL = { 30: "30 phút", 60: "60 phút", 180: "3 giờ" };

// Nếu các điểm đo gần nhất trải dài chưa tới ngần này phút, coi như CHƯA ĐỦ
// dữ liệu để ước lượng xu hướng - tránh chia cho một khoảng thời gian quá
// nhỏ khiến độ dốc bị khuếch đại thành số vô lý (ví dụ +200m/30 phút).
const MIN_PREDICTION_SPAN_MINUTES = 2;

const SEVERITY_COLOR = {
    normal: "#00a651",
    warning: "#f5a623",
    danger: "#d9534f",
    critical: "#8e1a1a",
    unknown: "#8a8a8a",
};

const SEVERITY_LABEL = {
    normal: "🟢 Bình thường",
    warning: "🟠 Cảnh báo",
    danger: "🔴 Nguy hiểm",
    critical: "🆘 SOS - Nguy cấp",
    unknown: "⚪ Chưa có dữ liệu",
};

const SEVERITY_DESC = {
    normal: "Mực nước đang ở mức an toàn. Không cần hành động.",
    warning: "Mực nước đã dâng qua Cảnh báo mức 1. Cần theo dõi.",
    danger: "Mực nước đã dâng qua Cảnh báo mức 2. Cần chuẩn bị phương án ứng phó.",
    critical: "Mực nước đã dâng qua Cảnh báo mức 3 (SOS). ESP32 đã/sẽ gửi SMS và gọi điện cảnh báo.",
    unknown: "Chưa có đủ dữ liệu để đánh giá tình trạng.",
    outOfRange: "Cảm biến ngoài tầm đo. Mực nước hiện tại được xem là bình thường.",
    notConnected: "Trạm chưa được kết nối - chưa có thiết bị ESP32 thật gửi dữ liệu.",
};

const ALL_SEVERITY_CLASSES = ["is-normal", "is-warning", "is-danger", "is-critical", "is-unknown"];

const STATION_IDS = ["station-1", "station-2", "station-3"];
const STATION_META = {
    "station-1": { name: "Trạm 1", deviceId: "ESP32-STATION-01", hasHardware: true, color: "#2196f3" },
    "station-2": { name: "Trạm 2", deviceId: "--", hasHardware: false, color: "#00a651" },
    "station-3": { name: "Trạm 3", deviceId: "--", hasHardware: false, color: "#d9534f" },
};

// Cặp trạm liền kề dùng để ước tính tốc độ truyền lũ (khoảng cách chỉnh
// được trên giao diện). Cặp "1-3" không có khoảng cách trực tiếp riêng -
// được cộng dồn từ "1-2" + "2-3" vì lũ được xem là truyền tuần tự qua Trạm 2.
const FLOW_PAIRS = {
    "1-2": { from: "station-1", to: "station-2", distanceKey: "1-2" },
    "2-3": { from: "station-2", to: "station-3", distanceKey: "2-3" },
    "1-3": { from: "station-1", to: "station-3", distanceKey: null }, // tổng "1-2" + "2-3"
};

// ------------------------------------------------------------
// TRẠNG THÁI DÙNG CHUNG (data model đa trạm)
// ------------------------------------------------------------
function createStationState(stationId) {
    return {
        id: stationId,
        distance: null, // giá trị thô từ cảm biến (m), có thể là -1 (ngoài tầm đo)
        outOfRange: false,
        lastUpdateRaw: null, // chuỗi "YYYY-MM-DD HH:MM:SS" từ ESP32
        lastReceivedAt: null, // Date.now() lúc web nhận được cập nhật gần nhất
        initialLevel: DEFAULT_INITIAL_LEVEL, // mực nước tham chiếu
        alertLevels: { ...DEFAULT_ALERT_LEVELS },
        history: [], // [{ t: Date, distance: number, rise: number }] - dùng vẽ biểu đồ/dự đoán/ước tính tốc độ
        webSettingsInitialized: false,
        isCleaningUp: false,
    };
}

const state = {
    currentViewId: "home",
    activeRange: "6h", // dùng chung cho biểu đồ trang chủ + từng trạm (đơn giản hoá, đồng bộ mốc thời gian)
    firebaseConnected: false,
    activeFlowPair: "1-2",
    distances: { ...DEFAULT_DISTANCES },
    distancesInitialized: false,
    stations: {
        "station-1": createStationState("station-1"),
        "station-2": createStationState("station-2"),
        "station-3": createStationState("station-3"),
    },
};

// ------------------------------------------------------------
// THAM CHIẾU FIREBASE THEO TRẠM
// ------------------------------------------------------------
function stationRefs(stationId) {
    return {
        flood: ref(database, `Stations/${stationId}/FloodSystem`),
        measurement: ref(database, `Stations/${stationId}/Measurement`),
        configuration: ref(database, `Stations/${stationId}/Configuration`),
        webSettings: ref(database, `WebSettings/${stationId}`),
    };
}

const distancesRef = ref(database, "WebSettings/StationDistances");

// ------------------------------------------------------------
// HÀM TIỆN ÍCH
// ------------------------------------------------------------
function isOutOfRange(distance) {
    return !Number.isFinite(distance) || distance < 0;
}

// rise = "mực nước đã dâng" so với mốc tham chiếu (m). Vì cảm biến đo
// KHOẢNG CÁCH xuống mặt nước nên khoảng cách càng nhỏ = nước càng dâng
// -> rise = initialLevel - currentDistance.
function computeRise(distance, initialLevel) {
    return initialLevel - distance;
}

function computeSeverity(rise, levels) {
    if (!Number.isFinite(rise)) return "unknown";
    if (rise >= levels.level3) return "critical";
    if (rise >= levels.level2) return "danger";
    if (rise >= levels.level1) return "warning";
    return "normal";
}

function formatVNDateTime(raw) {
    if (!raw || raw === "N/A") return "--:--:-- --/--/----";
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw);
    if (!m) return raw;
    const [, y, mo, d, h, mi, s] = m;
    return `${h}:${mi}:${s} ${d}/${mo}/${y}`;
}

function parseVNDateTimeToDate(raw) {
    if (!raw) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const h = Number(m[4]);
    const mi = Number(m[5]);
    const s = Number(m[6]);
    return new Date(y, mo - 1, d, h, mi, s);
}

// Hồi quy tuyến tính đơn giản (least squares) trên (phút, mức dâng) để
// ước lượng tốc độ thay đổi mực nước - CHỈ là ước lượng xu hướng thô từ
// vài lần đo gần nhất, KHÔNG phải mô hình dự báo lũ chuyên sâu.
function linearSlopePerMinute(points) {
    if (points.length < 2) return null;
    const t0 = points[0].t.getTime();
    const xs = points.map((p) => (p.t.getTime() - t0) / 60000);
    const ys = points.map((p) => p.rise);

    const spanMinutes = xs[xs.length - 1] - xs[0];
    if (spanMinutes < MIN_PREDICTION_SPAN_MINUTES) return null;

    const n = xs.length;
    const sumX = xs.reduce((a, b) => a + b, 0);
    const sumY = ys.reduce((a, b) => a + b, 0);
    const sumXY = xs.reduce((a, x, i) => a + x * ys[i], 0);
    const sumXX = xs.reduce((a, x) => a + x * x, 0);
    const denom = n * sumXX - sumX * sumX;
    if (Math.abs(denom) < 1e-9) return null;
    return (n * sumXY - sumX * sumY) / denom; // m / phút của mức dâng
}

function isStationFresh(s) {
    return !!s.lastReceivedAt && Date.now() - s.lastReceivedAt <= STALE_MS;
}

function isStationConnected(stationId) {
    return STATION_META[stationId].hasHardware;
}

function stationSeverity(s, stationId) {
    if (!isStationConnected(stationId)) return "unknown";
    if (s.distance === null) return "unknown";
    if (s.outOfRange) return "normal";
    return computeSeverity(computeRise(s.distance, s.initialLevel), s.alertLevels);
}

function setSeverityClasses(elm, severity) {
    elm.classList.remove(...ALL_SEVERITY_CLASSES);
    elm.classList.add(`is-${severity}`);
}

function flashSaved(button) {
    const original = button.textContent;
    button.textContent = "✔ Đã lưu";
    button.disabled = true;
    setTimeout(() => {
        button.textContent = original;
        button.disabled = false;
    }, 1100);
}

// ------------------------------------------------------------
// XÂY DỰNG GIAO DIỆN TỪNG TRẠM TỪ KHUÔN MẪU (stationViewTemplate)
// ------------------------------------------------------------
const stationViewTemplate = document.getElementById("stationViewTemplate");
const stationViewsContainer = document.getElementById("stationViewsContainer");
const navList = document.getElementById("navList");
const navStationTemplate = document.getElementById("navStationTemplate");

// stationEls[stationId] = { root, waterLevel, ... } - tham chiếu DOM riêng cho từng trạm
const stationEls = {};

// Chart.js instance riêng cho từng trạm + 1 instance dùng chung cho trang chủ
const stationCharts = {};
let homeChart = null;

function buildStationView(stationId) {
    const fragment = stationViewTemplate.content.cloneNode(true);
    const root = fragment.querySelector(".view--station");
    root.id = `view-${stationId}`;
    root.dataset.viewId = stationId;
    root.hidden = true;

    const meta = STATION_META[stationId];

    root.querySelectorAll('[data-field="stationLabel"]').forEach((elm) => {
        elm.textContent = meta.name;
    });
    root.querySelectorAll('[data-field="deviceName"]').forEach((elm) => {
        elm.textContent = meta.name;
    });
    root.querySelector('[data-field="deviceId"]').textContent = meta.deviceId;

    const els = {
        root,
        connectionStatus: root.querySelector('[data-field="connectionStatus"]'),
        waterLevel: root.querySelector('[data-field="waterLevel"]'),
        waterLevelUnit: root.querySelector('[data-field="waterLevelUnit"]'),
        waterLevelDelta: root.querySelector('[data-field="waterLevelDelta"]'),
        waterLevelDeltaIcon: root.querySelector('[data-field="waterLevelDeltaIcon"]'),
        waterLevelDeltaValue: root.querySelector('[data-field="waterLevelDeltaValue"]'),
        initialLevelInput: root.querySelector('[data-field="initialLevelInput"]'),
        initialLevelSetBtn: root.querySelector('[data-field="initialLevelSetBtn"]'),
        cardSystemStatus: root.querySelector('[data-field="cardSystemStatus"]'),
        systemStatusDot: root.querySelector('[data-field="systemStatusDot"]'),
        systemStatus: root.querySelector('[data-field="systemStatus"]'),
        statusDescription: root.querySelector('[data-field="statusDescription"]'),
        predictionRange: root.querySelector('[data-field="predictionRange"]'),
        predictionTrend: root.querySelector('[data-field="predictionTrend"]'),
        predictionTrendIcon: root.querySelector('[data-field="predictionTrendIcon"]'),
        predictionTrendText: root.querySelector('[data-field="predictionTrendText"]'),
        predictionDelta: root.querySelector('[data-field="predictionDelta"]'),
        predictionTime: root.querySelector('[data-field="predictionTime"]'),
        chartRangeTabs: root.querySelector('[data-field="chartRangeTabs"]'),
        chartEmptyNote: root.querySelector('[data-field="chartEmptyNote"]'),
        waterChartCanvas: root.querySelector('[data-field="waterChart"]'),
        alertLevel1Input: root.querySelector('[data-field="alertLevel1Input"]'),
        alertLevel2Input: root.querySelector('[data-field="alertLevel2Input"]'),
        alertLevel3Input: root.querySelector('[data-field="alertLevel3Input"]'),
        alertLevel1SetBtn: root.querySelector('[data-field="alertLevel1SetBtn"]'),
        alertLevel2SetBtn: root.querySelector('[data-field="alertLevel2SetBtn"]'),
        alertLevel3SetBtn: root.querySelector('[data-field="alertLevel3SetBtn"]'),
    };

    els.exportCsvBtn = root.querySelector('[data-field="exportCsvBtn"]');

    stationEls[stationId] = els;
    stationViewsContainer.appendChild(fragment);

    // Chart.js riêng cho trạm này - trục Y là MỨC NƯỚC DÂNG (m), không
    // phải khoảng cách cảm biến thô.
    stationCharts[stationId] = new Chart(els.waterChartCanvas, {
        type: "line",
        data: {
            labels: [],
            datasets: [
                {
                    label: `Mức nước dâng (m) - ${meta.name}`,
                    data: [],
                    borderColor: meta.color,
                    backgroundColor: hexToRgba(meta.color, 0.15),
                    borderWidth: 3,
                    tension: 0.35,
                    fill: true,
                    pointRadius: 4,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: true,
            scales: {
                y: {
                    title: { display: true, text: "Mức nước dâng (m)" },
                },
            },
        },
    });

    // Sự kiện giao diện riêng cho trạm này
    els.chartRangeTabs.querySelectorAll(".range-tab").forEach((btn) => {
        btn.addEventListener("click", () => setActiveRange(btn.dataset.range));
    });

    els.predictionRange.addEventListener("change", () => renderPredictionForStation(stationId));

    els.initialLevelSetBtn.addEventListener("click", () => {
        const val = parseFloat(els.initialLevelInput.value);
        if (!Number.isFinite(val) || val < 0) {
            els.initialLevelInput.setCustomValidity("Vui lòng nhập một số hợp lệ, không âm.");
            els.initialLevelInput.reportValidity();
            return;
        }
        els.initialLevelInput.setCustomValidity("");

        const { webSettings, flood } = stationRefs(stationId);
        update(webSettings, { InitialLevel: val })
            .then(() => {
                const s = state.stations[stationId];
                s.initialLevel = val;
                recomputeHistoryRise(stationId);
                if (meta.hasHardware) {
                    syncHardwareWarningLevel(stationId, flood, val, s.alertLevels.level3);
                }
                flashSaved(els.initialLevelSetBtn);
                renderStation(stationId);
                renderChartForStation(stationId);
                renderPredictionForStation(stationId);
                renderHomeIfActive();
            })
            .catch((error) => console.error(`Lỗi khi lưu Mực nước tham chiếu (${stationId}):`, error));
    });

    function handleSetAlertLevels(triggerBtn) {
        const v1 = parseFloat(els.alertLevel1Input.value);
        const v2 = parseFloat(els.alertLevel2Input.value);
        const v3 = parseFloat(els.alertLevel3Input.value);
        const values = [v1, v2, v3];
        const inputs = [els.alertLevel1Input, els.alertLevel2Input, els.alertLevel3Input];

        const invalidIndex = values.findIndex((v) => !Number.isFinite(v) || v < 0);
        if (invalidIndex !== -1) {
            inputs[invalidIndex].setCustomValidity("Vui lòng nhập một số hợp lệ, không âm.");
            inputs[invalidIndex].reportValidity();
            return;
        }

        if (!(v1 < v2 && v2 < v3)) {
            els.alertLevel2Input.setCustomValidity("Các mức cảnh báo phải tăng dần: Mức 1 < Mức 2 < Mức 3.");
            els.alertLevel2Input.reportValidity();
            return;
        }
        inputs.forEach((input) => input.setCustomValidity(""));

        const { webSettings, flood } = stationRefs(stationId);
        update(webSettings, { AlertLevels: { level1: v1, level2: v2, level3: v3 } })
            .then(() => {
                const s = state.stations[stationId];
                s.alertLevels = { level1: v1, level2: v2, level3: v3 };
                if (meta.hasHardware) {
                    syncHardwareWarningLevel(stationId, flood, s.initialLevel, v3);
                }
                if (triggerBtn) flashSaved(triggerBtn);
                renderStation(stationId);
                renderChartForStation(stationId);
                renderPredictionForStation(stationId);
                renderHomeIfActive();
            })
            .catch((error) => console.error(`Lỗi khi lưu ngưỡng cảnh báo (${stationId}):`, error));
    }

    els.alertLevel1SetBtn.addEventListener("click", () => handleSetAlertLevels(els.alertLevel1SetBtn));
    els.alertLevel2SetBtn.addEventListener("click", () => handleSetAlertLevels(els.alertLevel2SetBtn));
    els.alertLevel3SetBtn.addEventListener("click", () => handleSetAlertLevels(els.alertLevel3SetBtn));

    els.exportCsvBtn.addEventListener("click", () => exportStationHistoryCsv(stationId));
}

function hexToRgba(hex, alpha) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return hex;
    const r = parseInt(m[1], 16);
    const g = parseInt(m[2], 16);
    const b = parseInt(m[3], 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ------------------------------------------------------------
// XUẤT DỮ LIỆU CSV (từ bộ nhớ trình duyệt - state.stations[*].history)
// ------------------------------------------------------------
// Ghi chú: đây là xuất "nhanh" dữ liệu ĐANG CÓ TRONG PHIÊN LÀM VIỆC HIỆN
// TẠI (tối đa CLIENT_HISTORY_LIMIT điểm/trạm, nạp từ Firebase lúc mở
// trang + các điểm mới nhận qua realtime). Đây KHÔNG phải kho lưu trữ
// toàn bộ lịch sử - phần đó do khối "Sao lưu dữ liệu dài hạn (Google
// Sheets)" đảm nhiệm (xem GOOGLE_SHEETS_BACKUP bên dưới).
function csvEscape(value) {
    const s = String(value ?? "");
    if (/[",\n]/.test(s)) {
        return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}

function downloadCsv(filename, rows) {
    const csvContent = rows.map((row) => row.map(csvEscape).join(",")).join("\r\n");
    // Thêm BOM để Excel trên Windows nhận đúng UTF-8 (tránh lỗi hiển thị
    // tiếng Việt có dấu thành ký tự lạ khi mở trực tiếp bằng Excel).
    const blob = new Blob(["﻿" + csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function formatCsvTimestamp(date) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function exportStationHistoryCsv(stationId) {
    const s = state.stations[stationId];
    const meta = STATION_META[stationId];
    const rows = [["Trạm", "Thời gian đo", "Khoảng cách cảm biến (m)", "Mức nước dâng (m)"]];
    s.history.forEach((p) => {
        rows.push([meta.name, formatCsvTimestamp(p.t), p.distance, p.rise.toFixed(3)]);
    });
    if (rows.length === 1) {
        console.warn(`[${stationId}] Chưa có dữ liệu lịch sử để xuất CSV.`);
        return;
    }
    const stamp = formatCsvTimestamp(new Date()).replace(/[: ]/g, "-");
    downloadCsv(`${stationId}_${stamp}.csv`, rows);
}

function exportAllStationsHistoryCsv() {
    const rows = [["Trạm", "Thời gian đo", "Khoảng cách cảm biến (m)", "Mức nước dâng (m)"]];
    STATION_IDS.forEach((stationId) => {
        const s = state.stations[stationId];
        const meta = STATION_META[stationId];
        s.history.forEach((p) => {
            rows.push([meta.name, formatCsvTimestamp(p.t), p.distance, p.rise.toFixed(3)]);
        });
    });
    if (rows.length === 1) {
        console.warn("Chưa có dữ liệu lịch sử để xuất CSV.");
        return;
    }
    const stamp = formatCsvTimestamp(new Date()).replace(/[: ]/g, "-");
    downloadCsv(`tat-ca-tram_${stamp}.csv`, rows);
}

document.getElementById("exportCsvAllBtn").addEventListener("click", exportAllStationsHistoryCsv);

// ------------------------------------------------------------
// SAO LƯU DỮ LIỆU DÀI HẠN SANG GOOGLE SHEETS
// ------------------------------------------------------------
// Kiến trúc đã chốt: Firebase Realtime Database chỉ đóng vai trò bộ đệm
// GẦN ĐÂY (xem MAX_MEASUREMENTS), không cần giữ dữ liệu mãi mãi. Toàn bộ
// dữ liệu KHÔNG GIỚI HẠN được sao lưu sang Google Sheets (qua Google Apps
// Script Web App) mỗi khi có điểm đo mới VÀ trang web đang mở (không chạy
// nền 24/7 - đã được người dùng xác nhận là đủ dùng cho đồ án).
// Xem hướng dẫn deploy Web App trong: google-sheets-sync/README.md
const BACKUP_URL_STORAGE_KEY = "floodIot.googleSheetsWebAppUrl";

const backupState = {
    webAppUrl: null,
    sentCount: 0,
    lastError: null,
};

function loadBackupUrl() {
    try {
        return localStorage.getItem(BACKUP_URL_STORAGE_KEY) || "";
    } catch (error) {
        console.error("Không đọc được localStorage (Google Sheets Web App URL):", error);
        return "";
    }
}

function saveBackupUrl(url) {
    try {
        localStorage.setItem(BACKUP_URL_STORAGE_KEY, url);
    } catch (error) {
        console.error("Không lưu được localStorage (Google Sheets Web App URL):", error);
    }
}

const backupStatusDot = document.getElementById("backupStatusDot");
const backupStatusText = document.getElementById("backupStatusText");
const backupWebAppUrlInput = document.getElementById("backupWebAppUrlInput");
const backupSaveUrlBtn = document.getElementById("backupSaveUrlBtn");
const backupCounter = document.getElementById("backupCounter");

function setBackupStatusDot(kind) {
    // kind: "unknown" | "normal" (sẵn sàng/thành công) | "warning" (đang gửi) | "danger" (lỗi)
    ALL_SEVERITY_CLASSES.forEach((c) => backupStatusDot.classList.remove(c));
    const map = {
        unknown: "is-unknown",
        normal: "is-normal",
        warning: "is-warning",
        danger: "is-danger",
    };
    backupStatusDot.classList.add(map[kind] || "is-unknown");
}

function renderBackupStatus() {
    backupCounter.textContent = `Đã sao lưu: ${backupState.sentCount} bản ghi trong phiên này.`;

    if (!backupState.webAppUrl) {
        setBackupStatusDot("unknown");
        backupStatusText.textContent = "Chưa cấu hình Google Sheets Web App URL.";
        return;
    }
    if (backupState.lastError) {
        setBackupStatusDot("danger");
        backupStatusText.textContent = `Lỗi khi sao lưu: ${backupState.lastError}`;
        return;
    }
    setBackupStatusDot("normal");
    backupStatusText.textContent = backupState.sentCount > 0
        ? "Đang hoạt động - dữ liệu mới sẽ tự động sao lưu sang Google Sheets."
        : "Đã cấu hình - sẵn sàng sao lưu khi có điểm đo mới.";
}

function initBackup() {
    const savedUrl = loadBackupUrl();
    backupState.webAppUrl = savedUrl || null;
    backupWebAppUrlInput.value = savedUrl;
    renderBackupStatus();
}

backupSaveUrlBtn.addEventListener("click", () => {
    const url = backupWebAppUrlInput.value.trim();
    if (url && !/^https:\/\/script\.google\.com\/macros\//.test(url)) {
        backupWebAppUrlInput.setCustomValidity(
            "URL không hợp lệ. Cần dán đúng URL Web App dạng https://script.google.com/macros/s/.../exec"
        );
        backupWebAppUrlInput.reportValidity();
        return;
    }
    backupWebAppUrlInput.setCustomValidity("");
    backupState.webAppUrl = url || null;
    backupState.lastError = null;
    saveBackupUrl(url);
    flashSaved(backupSaveUrlBtn);
    renderBackupStatus();

    // Vừa cấu hình xong URL: gửi bù ngay dữ liệu lịch sử ĐÃ NẠP SẴN cho
    // từng trạm (từ lúc mở trang, xem pendingBackfillByStation), không
    // cần đợi có điểm đo mới mới bắt đầu sao lưu và không cần gọi lại
    // Firebase lần nữa.
    if (backupState.webAppUrl) {
        Object.keys(pendingBackfillByStation).forEach((stationId) => {
            backfillBackupForStation(stationId, pendingBackfillByStation[stationId]);
        });
    }
});

// Gửi 1 bản ghi sang Google Sheets. Không chặn luồng chính của web nếu
// mạng lỗi hoặc Web App chưa cấu hình đúng - chỉ ghi log + cập nhật badge
// trạng thái, KHÔNG throw ra ngoài, KHÔNG làm gián đoạn việc hiển thị dữ
// liệu realtime trên giao diện.
function sendToGoogleSheetsBackup(stationId, point) {
    if (!backupState.webAppUrl) return;

    const meta = STATION_META[stationId];
    const payload = {
        stationId,
        stationName: meta.name,
        timestamp: formatCsvTimestamp(point.t),
        distance: point.distance,
        rise: Number(point.rise.toFixed(3)),
    };

    // mode: "no-cors" vì Google Apps Script Web App (deploy "Ai cũng có
    // thể truy cập") không trả CORS header cho phép đọc response từ
    // trình duyệt - nhưng request POST vẫn được gửi và Apps Script vẫn
    // ghi được dữ liệu vào Google Sheets, ta chỉ không đọc được response.
    fetch(backupState.webAppUrl, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
    })
        .then(() => {
            backupState.sentCount += 1;
            backupState.lastError = null;
            renderBackupStatus();
        })
        .catch((error) => {
            backupState.lastError = error.message || "Không gửi được yêu cầu (kiểm tra kết nối mạng).";
            console.error(`[${stationId}] Lỗi khi sao lưu sang Google Sheets:`, error);
            renderBackupStatus();
        });
}

// ------------------------------------------------------------
// "BÙ DỮ LIỆU" KHI MỞ LẠI WEB
// ------------------------------------------------------------
// Vấn đề: nếu web bị đóng trong lúc ESP32 vẫn gửi dữ liệu lên Firebase
// (Stations/<id>/Measurement), những điểm đo đó KHÔNG được sao lưu sang
// Google Sheets vì onValue(flood, ...) chỉ bắt được thay đổi khi trình
// duyệt đang lắng nghe. Để không mất dữ liệu, mỗi khi mở lại web, hệ
// thống sẽ gửi TOÀN BỘ Measurement đang có trên Firebase cho từng trạm
// (tối đa MAX_MEASUREMENTS bản ghi/trạm - xem ghi chú ở hằng số đó) sang
// Google Sheets theo dạng batch. Apps Script (Code.gs) tự lọc trùng theo
// khoá "Trạm + Thời gian đo" nên gửi lại các bản ghi ĐÃ có trước đó là AN
// TOÀN, không tạo dòng trùng lặp trong sheet.
//
// QUAN TRỌNG VỀ THỜI ĐIỂM GỌI: hàm này CHỈ được gọi từ bên trong khối
// get(measurement).then(...) đã có sẵn (nạp lịch sử cho biểu đồ khi mở
// trang) - dùng LẠI đúng dữ liệu vừa tải về, KHÔNG gọi get() thêm một
// lần riêng ở top-level của module. Lý do: nếu gọi get() ngay khi module
// script.js bắt đầu chạy (trước khi Firebase SDK kịp kết nối/đồng bộ),
// có rủi ro đọc phải dữ liệu rỗng do race condition, khiến việc bù dữ
// liệu bị bỏ sót ngay từ lần tải trang - trong khi khối get(measurement)
// hiện có đã hoạt động đúng cho việc vẽ biểu đồ nên tận dụng lại là an
// toàn nhất.
//
// GIỚI HẠN CẦN LƯU Ý: cơ chế này chỉ bù được những gì Firebase CÒN GIỮ
// (tối đa MAX_MEASUREMENTS bản ghi gần nhất/trạm). Nếu web bị đóng lâu
// hơn khoảng thời gian để ESP32 ghi đủ số bản ghi đó, các điểm đo cũ
// nhất sẽ bị Firebase tự xoá TRƯỚC KHI kịp bù sang Sheets và mất vĩnh
// viễn - không có cách khắc phục nếu không có một tiến trình chạy nền
// độc lập với việc mở/đóng web (ví dụ Cloud Functions), điều mà đồ án
// hiện tại không cần vì thời gian đóng web dự kiến chỉ vài giờ đến 1-2
// ngày, thấp hơn nhiều so với sức chứa hiện tại của bộ đệm Firebase.
//
// stationId: trạm nguồn. records: mảng { t: Date, distance, rise } đã
// được tính sẵn (định dạng giống state.stations[id].history).
function backfillBackupForStation(stationId, points) {
    if (!backupState.webAppUrl || points.length === 0) return;

    const meta = STATION_META[stationId];
    const records = points.map((p) => ({
        stationId,
        stationName: meta.name,
        timestamp: formatCsvTimestamp(p.t),
        distance: p.distance,
        rise: Number(p.rise.toFixed(3)),
    }));

    // mode: "no-cors" -> không đọc được response, nên chỉ báo là "đã gửi
    // yêu cầu bù", KHÔNG khẳng định Google Sheets đã ghi thành công
    // (Apps Script có thể vẫn lỗi phía server mà web không biết được, vì
    // lý do CORS như đã giải thích ở sendToGoogleSheetsBackup() trên).
    fetch(backupState.webAppUrl, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ records }),
    })
        .then(() => {
            console.log(`[${stationId}] Đã gửi yêu cầu bù ${records.length} bản ghi sang Google Sheets (bù dữ liệu khi mở lại web).`);
        })
        .catch((error) => {
            console.error(`[${stationId}] Lỗi khi bù dữ liệu sang Google Sheets:`, error);
            backupState.lastError = error.message || "Không gửi được yêu cầu bù dữ liệu.";
            renderBackupStatus();
        });
}

// Danh sách "việc bù dữ liệu đang chờ" - dùng khi người dùng cấu hình
// Web App URL SAU KHI lịch sử Measurement của các trạm đã được nạp
// xong (trường hợp thường gặp: mở web trước, dán URL sau). Mỗi trạm chỉ
// lưu 1 bộ dữ liệu mới nhất đã nạp được.
const pendingBackfillByStation = {};

initBackup();

function buildNavItem(stationId) {
    const fragment = navStationTemplate.content.cloneNode(true);
    const btn = fragment.querySelector(".nav-item");
    btn.id = `navItem-${stationId}`;
    btn.dataset.viewId = stationId;
    btn.querySelector('[data-field="deviceName"]').textContent = STATION_META[stationId].name;
    btn.addEventListener("click", () => switchView(stationId));
    navList.appendChild(fragment);
}

// Trạm 1 và 2 đã có sẵn trong HTML tĩnh; xây thêm Trạm 3 (và bất kỳ
// trạm nào khác được khai báo trong STATION_META/STATION_IDS) qua JS,
// đúng theo hướng dẫn "clone khuôn mẫu để thêm trạm mới mà không cần
// sửa cấu trúc HTML".
STATION_IDS.forEach((stationId) => buildStationView(stationId));

// Gắn sự kiện cho các nav-item TRẠM đã có sẵn trong HTML (Trạm 1, 2, 3)
document.querySelectorAll(".nav-item--station").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.viewId));
});
document.getElementById("navItem-home").addEventListener("click", () => switchView("home"));

// ------------------------------------------------------------
// BIỂU ĐỒ TRANG CHỦ (so sánh mức nước dâng cả 3 trạm)
// ------------------------------------------------------------
const homeChartCanvas = document.getElementById("homeWaterChart");
const homeChartEmptyNote = document.getElementById("homeChartEmptyNote");
const homeChartRangeTabs = document.querySelectorAll("#homeChartRangeTabs .range-tab");

homeChart = new Chart(homeChartCanvas, {
    type: "line",
    data: {
        labels: [],
        datasets: STATION_IDS.map((stationId) => ({
            label: STATION_META[stationId].name,
            data: [],
            borderColor: STATION_META[stationId].color,
            backgroundColor: hexToRgba(STATION_META[stationId].color, 0.12),
            borderWidth: 3,
            tension: 0.35,
            fill: false,
            pointRadius: 3,
            spanGaps: true,
        })),
    },
    options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: true,
        scales: {
            y: {
                title: { display: true, text: "Mức nước dâng (m)" },
            },
        },
    },
});

homeChartRangeTabs.forEach((btn) => {
    btn.addEventListener("click", () => setActiveRange(btn.dataset.range));
});

// ------------------------------------------------------------
// ĐIỀU HƯỚNG NHIỀU TRANG
// ------------------------------------------------------------
function switchView(viewId) {
    if (viewId === state.currentViewId) return;
    state.currentViewId = viewId;

    document.querySelectorAll(".nav-item").forEach((btn) => {
        const active = btn.dataset.viewId === viewId;
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-pressed", active ? "true" : "false");
    });

    document.getElementById("view-home").hidden = viewId !== "home";
    STATION_IDS.forEach((stationId) => {
        stationEls[stationId].root.hidden = viewId !== stationId;
    });

    if (viewId === "home") {
        renderHome();
    } else {
        renderStation(viewId);
        renderChartForStation(viewId);
        renderPredictionForStation(viewId);
    }
}

// Cho phép bảng trạng thái ở Trang chủ điều hướng sang trang chi tiết trạm
window.__switchToStationView = (stationId) => switchView(stationId);

// ------------------------------------------------------------
// CẬP NHẬT LỊCH SỬ (rise) MỖI KHI MỰC NƯỚC THAM CHIẾU THAY ĐỔI
// ------------------------------------------------------------
// Lịch sử lưu cả distance thô lẫn rise đã tính sẵn để vẽ biểu đồ/ước
// tính tốc độ truyền lũ mà không cần tính lại mỗi lần render. Khi mực
// nước tham chiếu đổi, phải tính lại "rise" cho toàn bộ lịch sử đã có.
function recomputeHistoryRise(stationId) {
    const s = state.stations[stationId];
    s.history.forEach((point) => {
        point.rise = computeRise(point.distance, s.initialLevel);
    });
}

// ------------------------------------------------------------
// BIỂU ĐỒ THEO KHOẢNG THỜI GIAN (dùng chung cho trang chủ + từng trạm)
// ------------------------------------------------------------
function formatChartLabel(date, rangeKey) {
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    const ss = String(date.getSeconds()).padStart(2, "0");
    if (rangeKey === "7d") {
        const d = String(date.getDate()).padStart(2, "0");
        const mo = String(date.getMonth() + 1).padStart(2, "0");
        return `${d}/${mo} ${hh}:${mm}`;
    }
    return `${hh}:${mm}:${ss}`;
}

function renderChartForStation(stationId) {
    if (state.currentViewId !== stationId) return;
    const els = stationEls[stationId];
    const s = state.stations[stationId];
    const rangeMs = RANGE_MS[state.activeRange] ?? RANGE_MS["6h"];
    const now = Date.now();
    const points = s.history.filter((p) => now - p.t.getTime() <= rangeMs);

    const chart = stationCharts[stationId];
    chart.data.labels = points.map((p) => formatChartLabel(p.t, state.activeRange));
    chart.data.datasets[0].data = points.map((p) => p.rise);
    chart.update();

    els.chartEmptyNote.textContent = isStationConnected(stationId)
        ? "Chưa đủ dữ liệu lịch sử cho khoảng thời gian này."
        : `${STATION_META[stationId].name} chưa được kết nối - chưa có dữ liệu lịch sử.`;
    els.chartEmptyNote.hidden = points.length > 0;
}

function renderHomeChart() {
    const rangeMs = RANGE_MS[state.activeRange] ?? RANGE_MS["6h"];
    const now = Date.now();

    // Gộp toàn bộ mốc thời gian của 3 trạm lại thành 1 trục nhãn chung
    // (mỗi trạm có thể có mật độ đo khác nhau), rồi map mỗi trạm vào
    // đúng vị trí thời gian của nó - KHÔNG trộn dữ liệu giữa các trạm.
    const allTimestamps = new Set();
    STATION_IDS.forEach((stationId) => {
        state.stations[stationId].history
            .filter((p) => now - p.t.getTime() <= rangeMs)
            .forEach((p) => allTimestamps.add(p.t.getTime()));
    });
    const sortedTimes = Array.from(allTimestamps).sort((a, b) => a - b);

    let hasAnyPoint = false;
    homeChart.data.labels = sortedTimes.map((t) => formatChartLabel(new Date(t), state.activeRange));
    STATION_IDS.forEach((stationId, idx) => {
        const s = state.stations[stationId];
        const pointsByTime = new Map(
            s.history.filter((p) => now - p.t.getTime() <= rangeMs).map((p) => [p.t.getTime(), p.rise])
        );
        if (pointsByTime.size > 0) hasAnyPoint = true;
        homeChart.data.datasets[idx].data = sortedTimes.map((t) => (pointsByTime.has(t) ? pointsByTime.get(t) : null));
    });
    homeChart.update();

    homeChartEmptyNote.hidden = hasAnyPoint;
}

function setActiveRange(key) {
    state.activeRange = key;

    document.querySelectorAll(".chart-range-tabs .range-tab, #homeChartRangeTabs .range-tab").forEach((btn) => {
        const active = btn.dataset.range === key;
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-pressed", active ? "true" : "false");
    });

    if (state.currentViewId === "home") {
        renderHomeChart();
    } else {
        renderChartForStation(state.currentViewId);
    }
}

// ------------------------------------------------------------
// DỰ ĐOÁN XU HƯỚNG (ước lượng tuyến tính đơn giản trên mức dâng)
// ------------------------------------------------------------
function renderPredictionForStation(stationId) {
    if (state.currentViewId !== stationId) return;
    const els = stationEls[stationId];
    const s = state.stations[stationId];
    const horizonMin = Number(els.predictionRange.value) || 30;
    const horizonLabel = HORIZON_LABEL[horizonMin] || `${horizonMin} phút`;

    const recentPoints = s.history.slice(-6);
    const slope = isStationConnected(stationId) && !s.outOfRange ? linearSlopePerMinute(recentPoints) : null;

    els.predictionTrend.classList.remove("is-up", "is-down", "is-flat");

    if (slope == null) {
        els.predictionTrend.classList.add("is-flat");
        els.predictionTrend.style.color = "";
        els.predictionTrendIcon.textContent = "--";
        els.predictionTrendText.textContent = isStationConnected(stationId)
            ? "Chưa đủ dữ liệu để dự đoán"
            : "Chưa có dữ liệu để dự đoán";
        els.predictionDelta.textContent = "--";
        els.predictionTime.textContent = isStationConnected(stationId) ? horizonLabel : "--";
        return;
    }

    // slope đã tính trực tiếp trên "rise" (mức dâng) -> không cần đổi dấu.
    const predictedRiseChange = slope * horizonMin;
    const dir = Math.abs(predictedRiseChange) < 0.01 ? "flat" : predictedRiseChange > 0 ? "up" : "down";

    els.predictionTrend.classList.add(`is-${dir}`);
    els.predictionTrendIcon.textContent = dir === "flat" ? "→" : dir === "up" ? "↑" : "↓";
    els.predictionTrendText.textContent =
        dir === "flat" ? "Mực nước dự kiến ổn định" : dir === "up" ? "Dự kiến mực nước dâng" : "Dự kiến mực nước rút";
    els.predictionDelta.textContent = `${predictedRiseChange >= 0 ? "+" : ""}${predictedRiseChange.toFixed(2)} m`;
    els.predictionTime.textContent = horizonLabel;
}

// ------------------------------------------------------------
// HIỂN THỊ MỘT TRẠM (dùng chung cho cả 3 trạm, kể cả chưa kết nối)
// ------------------------------------------------------------
function renderStation(stationId) {
    const els = stationEls[stationId];
    const s = state.stations[stationId];
    const meta = STATION_META[stationId];
    const connected = isStationConnected(stationId);

    if (!connected) {
        // Trạm chưa có ESP32 thật -> hiển thị "chưa kết nối", vô hiệu hoá input.
        els.waterLevel.textContent = "--";
        els.waterLevelUnit.style.display = "none";
        els.waterLevelDelta.hidden = true;

        setSeverityClasses(els.cardSystemStatus, "unknown");
        setSeverityClasses(els.systemStatusDot, "unknown");
        setSeverityClasses(els.systemStatus, "unknown");
        els.systemStatus.textContent = SEVERITY_LABEL.unknown;
        els.statusDescription.textContent = SEVERITY_DESC.notConnected;

        els.initialLevelInput.value = "";
        els.initialLevelInput.placeholder = "--";
        els.initialLevelInput.disabled = true;
        els.initialLevelSetBtn.disabled = true;

        [1, 2, 3].forEach((n) => {
            const input = els[`alertLevel${n}Input`];
            input.value = "";
            input.placeholder = "--";
            input.disabled = true;
            els[`alertLevel${n}SetBtn`].disabled = true;
        });

        els.predictionRange.disabled = true;
        els.chartRangeTabs.querySelectorAll(".range-tab").forEach((b) => (b.disabled = true));

        els.connectionStatus.textContent = "Chưa kết nối";
        els.connectionStatus.classList.add("is-offline");

        if (els.root.hidden === false) {
            document.getElementById("lastUpdate").textContent = document.getElementById("lastUpdate").textContent;
        }
        return;
    }

    // --- Card 1: mực nước hiện tại ---
    if (s.distance === null) {
        els.waterLevel.textContent = "Đang tải...";
        els.waterLevelUnit.style.display = "none";
        els.waterLevelDelta.hidden = true;
    } else if (s.outOfRange) {
        els.waterLevel.textContent = "Ngoài tầm đo";
        els.waterLevelUnit.style.display = "none";
        els.waterLevelDelta.hidden = true;
    } else {
        els.waterLevel.textContent = s.distance.toFixed(2);
        els.waterLevelUnit.style.display = "";
        els.waterLevelDelta.hidden = false;

        const rise = computeRise(s.distance, s.initialLevel);
        els.waterLevelDeltaValue.textContent = `${rise >= 0 ? "+" : ""}${rise.toFixed(2)} m`;
        els.waterLevelDeltaIcon.textContent = Math.abs(rise) < 0.005 ? "→" : rise > 0 ? "↑" : "↓";

        const sev = computeSeverity(rise, s.alertLevels);
        els.waterLevelDelta.style.color = SEVERITY_COLOR[sev] || "";
    }

    // --- Card 3: tình trạng hệ thống ---
    const severity = stationSeverity(s, stationId);
    setSeverityClasses(els.cardSystemStatus, severity);
    setSeverityClasses(els.systemStatusDot, severity);
    setSeverityClasses(els.systemStatus, severity);
    els.systemStatus.textContent = SEVERITY_LABEL[severity];
    els.statusDescription.textContent = s.outOfRange ? SEVERITY_DESC.outOfRange : SEVERITY_DESC[severity];

    // --- Card 2: mực nước tham chiếu ---
    if (document.activeElement !== els.initialLevelInput) {
        els.initialLevelInput.value = s.initialLevel.toFixed(2);
    }
    els.initialLevelInput.disabled = false;
    els.initialLevelInput.placeholder = "";
    els.initialLevelSetBtn.disabled = false;

    // --- F: 3 mức cảnh báo ---
    [1, 2, 3].forEach((n) => {
        const input = els[`alertLevel${n}Input`];
        if (document.activeElement !== input) {
            input.value = s.alertLevels[`level${n}`].toFixed(2);
        }
        input.disabled = false;
        input.placeholder = "";
        els[`alertLevel${n}SetBtn`].disabled = false;
    });

    els.predictionRange.disabled = false;
    els.chartRangeTabs.querySelectorAll(".range-tab").forEach((b) => (b.disabled = false));

    // --- Tóm tắt trạm (mục C) ---
    const fresh = isStationFresh(s);
    els.connectionStatus.textContent = fresh ? "Đang online" : "Mất kết nối";
    els.connectionStatus.classList.toggle("is-offline", !fresh);

    if (state.currentViewId === stationId) {
        document.getElementById("lastUpdate").textContent = formatVNDateTime(s.lastUpdateRaw);
    }
}

// ------------------------------------------------------------
// TRẠNG THÁI HỆ THỐNG CHUNG (header) - tổng hợp cả 3 trạm: hệ thống
// coi là khoẻ mạnh khi Firebase đang kết nối VÀ không có trạm đã kết
// nối nào bị mất dữ liệu (cũ).
// ------------------------------------------------------------
function renderHeaderStatus() {
    const anyStale = STATION_IDS.some((id) => isStationConnected(id) && !isStationFresh(state.stations[id]));
    const healthy = state.firebaseConnected && !anyStale;
    const systemHealthDot = document.getElementById("systemHealthDot");
    const systemHealthText = document.getElementById("systemHealthText");
    systemHealthDot.classList.toggle("is-online", healthy);
    systemHealthDot.classList.toggle("is-danger", !healthy);
    systemHealthText.textContent = healthy ? "Hệ thống hoạt động tốt" : "Mất kết nối / dữ liệu cũ";

    // Cập nhật "Cập nhật lần cuối" ở header theo trạm đang xem (nếu là
    // trang chủ, lấy thời điểm mới nhất trong số các trạm đã kết nối).
    if (state.currentViewId === "home") {
        let latest = null;
        STATION_IDS.forEach((id) => {
            const s = state.stations[id];
            if (isStationConnected(id) && s.lastReceivedAt && (!latest || s.lastReceivedAt > latest.receivedAt)) {
                latest = { receivedAt: s.lastReceivedAt, raw: s.lastUpdateRaw };
            }
        });
        document.getElementById("lastUpdate").textContent = latest ? formatVNDateTime(latest.raw) : "--:--:-- --/--/----";
    }
}

function renderHomeIfActive() {
    if (state.currentViewId === "home") renderHome();
}

// ============================================================
// TRANG CHỦ - TỔNG QUAN TOÀN HỆ THỐNG
// ============================================================
function renderHome() {
    renderOverviewCards();
    renderHomeChart();
    renderStationStatusTable();
    renderRecentAlerts();
    renderFlowSpeedPanel();
}

function renderOverviewCards() {
    const total = STATION_IDS.length;
    let online = 0;
    let offline = 0;
    let alerting = 0;

    STATION_IDS.forEach((id) => {
        const s = state.stations[id];
        if (!isStationConnected(id)) {
            offline += 1;
            return;
        }
        if (isStationFresh(s)) {
            online += 1;
        } else {
            offline += 1;
        }
        const severity = stationSeverity(s, id);
        if (severity === "warning" || severity === "danger" || severity === "critical") {
            alerting += 1;
        }
    });

    document.getElementById("totalStationsValue").textContent = String(total);
    document.getElementById("onlineStationsValue").textContent = String(online);
    document.getElementById("offlineStationsValue").textContent = String(offline);
    document.getElementById("alertStationsValue").textContent = String(alerting);
}

function renderStationStatusTable() {
    const tbody = document.getElementById("stationStatusTableBody");
    tbody.innerHTML = "";

    STATION_IDS.forEach((id) => {
        const s = state.stations[id];
        const meta = STATION_META[id];
        const connected = isStationConnected(id);
        const fresh = connected && isStationFresh(s);
        const severity = stationSeverity(s, id);

        const rise = connected && s.distance !== null && !s.outOfRange ? computeRise(s.distance, s.initialLevel) : null;
        const currentLevelText = !connected || s.distance === null
            ? "--"
            : s.outOfRange
                ? "Ngoài tầm đo"
                : `${s.distance.toFixed(2)} m`;
        const riseText = rise === null ? "--" : `${rise >= 0 ? "+" : ""}${rise.toFixed(2)} m`;

        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td>
                <span class="station-status-name">
                    <span class="status-dot is-${connected && fresh ? "online" : "unknown"}" aria-hidden="true"></span>
                    ${meta.name}
                </span>
            </td>
            <td>${currentLevelText}</td>
            <td>${riseText}</td>
            <td><span class="status-pill is-${severity}">${SEVERITY_LABEL[severity]}</span></td>
            <td>
                <span class="status-dot is-${connected ? (fresh ? "online" : "danger") : "unknown"}" aria-hidden="true"></span>
                ${connected ? (fresh ? "Online" : "Mất kết nối") : "Offline"}
            </td>
            <td>${connected ? formatVNDateTime(s.lastUpdateRaw) : "--:--:-- --/--/----"}</td>
            <td><button type="button" class="btn-view-detail">Xem chi tiết</button></td>
        `;
        tr.querySelector(".btn-view-detail").addEventListener("click", () => switchView(id));
        tbody.appendChild(tr);
    });
}

// Danh sách cảnh báo gần đây được suy ra trực tiếp từ lịch sử "rise" đã
// ghi nhận của từng trạm (không tạo dữ liệu giả): mỗi lần mức dâng của
// một trạm bước qua một ngưỡng cảnh báo (so với điểm đo liền trước) được
// coi là một sự kiện cảnh báo.
function computeRecentAlerts(limit = 8) {
    const events = [];

    STATION_IDS.forEach((id) => {
        if (!isStationConnected(id)) return;
        const s = state.stations[id];
        let prevSeverity = null;
        s.history.forEach((point) => {
            const sev = computeSeverity(point.rise, s.alertLevels);
            if (prevSeverity !== null && sev !== prevSeverity) {
                events.push({
                    stationId: id,
                    stationName: STATION_META[id].name,
                    t: point.t,
                    severity: sev,
                    rise: point.rise,
                });
            }
            prevSeverity = sev;
        });
    });

    events.sort((a, b) => b.t.getTime() - a.t.getTime());
    return events.slice(0, limit);
}

const ALERT_EVENT_TEXT = {
    normal: "Mực nước trở lại mức bình thường",
    warning: "Mực nước vượt ngưỡng cảnh báo mức 1",
    danger: "Mực nước vượt ngưỡng cảnh báo mức 2",
    critical: "Mực nước vượt ngưỡng cảnh báo mức 3 (SOS)",
};

const ALERT_EVENT_ICON = {
    normal: "✅",
    warning: "⚠️",
    danger: "🔴",
    critical: "🆘",
};

function renderRecentAlerts() {
    const list = document.getElementById("recentAlertsList");
    const events = computeRecentAlerts();

    list.innerHTML = "";

    if (events.length === 0) {
        const li = document.createElement("li");
        li.className = "recent-alerts-empty";
        li.textContent = "Chưa có cảnh báo nào được ghi nhận.";
        list.appendChild(li);
        return;
    }

    events.forEach((evt) => {
        const li = document.createElement("li");
        li.className = `recent-alert-item is-${evt.severity}`;
        li.innerHTML = `
            <div class="recent-alert-main">
                <span class="recent-alert-icon" aria-hidden="true">${ALERT_EVENT_ICON[evt.severity]}</span>
                <div>
                    <span class="recent-alert-time">${formatVNDateTime(
                        `${evt.t.getFullYear()}-${String(evt.t.getMonth() + 1).padStart(2, "0")}-${String(
                            evt.t.getDate()
                        ).padStart(2, "0")} ${String(evt.t.getHours()).padStart(2, "0")}:${String(
                            evt.t.getMinutes()
                        ).padStart(2, "0")}:${String(evt.t.getSeconds()).padStart(2, "0")}`
                    )} · ${evt.stationName}</span>
                    <span class="recent-alert-text">${ALERT_EVENT_TEXT[evt.severity]}</span>
                    <span class="recent-alert-desc">Mức nước dâng tại thời điểm ghi nhận</span>
                </div>
            </div>
            <span class="recent-alert-value">${evt.rise >= 0 ? "+" : ""}${evt.rise.toFixed(2)} m</span>
        `;
        list.appendChild(li);
    });
}

// ------------------------------------------------------------
// ƯỚC TÍNH TỐC ĐỘ TRUYỀN LŨ GIỮA CÁC TRẠM
// ------------------------------------------------------------
// CƠ CHẾ MỚI (tự động, không cần người dùng nhập mức nước dâng cụ thể):
// với mỗi trạm, quét lịch sử "rise" theo thời gian tăng dần và tìm ĐIỂM
// BẮT ĐẦU của đợt dâng gần nhất - tức là điểm mà độ dốc rise (m/phút)
// bắt đầu vượt RISE_START_MIN_SLOPE_PER_MIN và duy trì liên tục qua ít
// nhất RISE_START_MIN_CONSECUTIVE_POINTS điểm đo kế tiếp. Đây thay thế
// hoàn toàn cách làm cũ (tìm thời điểm rise vượt một ngưỡng mét cố định
// do người dùng nhập).
//
// afterTime (tuỳ chọn): nếu có, chỉ xét các điểm bắt đầu dâng xảy ra SAU
// thời điểm này - dùng khi khớp sự kiện của trạm đích với sự kiện đã
// tìm được ở trạm nguồn (lấy đợt dâng gần nhất xảy ra sau đó).
function detectRiseStartEvent(stationId, afterTime) {
    const s = state.stations[stationId];
    if (!isStationConnected(stationId)) return null;
    const sorted = [...s.history].sort((a, b) => a.t.getTime() - b.t.getTime());
    const minSpan = RISE_START_MIN_CONSECUTIVE_POINTS - 1;

    for (let i = 0; i < sorted.length; i += 1) {
        if (afterTime && sorted[i].t.getTime() <= afterTime.getTime()) continue;

        // Cần đủ điểm phía sau i để kiểm tra chuỗi dâng liên tục.
        if (i + minSpan >= sorted.length) break;

        let isRisingRun = true;
        for (let k = i; k < i + minSpan; k += 1) {
            const a = sorted[k];
            const b = sorted[k + 1];
            const minutes = (b.t.getTime() - a.t.getTime()) / 60000;
            if (minutes <= 0) {
                isRisingRun = false;
                break;
            }
            const slope = (b.rise - a.rise) / minutes;
            if (slope < RISE_START_MIN_SLOPE_PER_MIN) {
                isRisingRun = false;
                break;
            }
        }

        if (isRisingRun) {
            // Điểm i là điểm cuối cùng TRƯỚC KHI đợt dâng bắt đầu tăng rõ
            // rệt (hoặc chính là điểm khởi đầu nếu i === 0) -> coi đây là
            // thời điểm bắt đầu đợt dâng.
            return sorted[i].t;
        }
    }
    return null;
}

function formatDurationMinutes(ms) {
    const totalMinutes = Math.round(ms / 60000);
    if (totalMinutes < 60) return `${totalMinutes} phút`;
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return m === 0 ? `${h} giờ` : `${h} giờ ${m} phút`;
}

function getPairDistanceKm(pairKey) {
    const pair = FLOW_PAIRS[pairKey];
    if (pair.distanceKey) return state.distances[pair.distanceKey];
    // "1-3" = tổng khoảng cách "1-2" + "2-3" (lũ truyền tuần tự qua Trạm 2)
    return state.distances["1-2"] + state.distances["2-3"];
}

function renderFlowSpeedPanel() {
    const pairKey = state.activeFlowPair;
    const pair = FLOW_PAIRS[pairKey];
    const distanceKm = getPairDistanceKm(pairKey);

    const fromMeta = STATION_META[pair.from];
    const toMeta = STATION_META[pair.to];
    const fromState = state.stations[pair.from];
    const toState = state.stations[pair.to];

    // Tự động phát hiện: thời điểm trạm nguồn bắt đầu một đợt dâng, rồi
    // tìm đợt dâng gần nhất của trạm đích xảy ra SAU thời điểm đó (được
    // xem là cùng một đợt lũ truyền tới) - không còn phụ thuộc vào một
    // mức nước dâng cố định do người dùng nhập.
    const fromTime = detectRiseStartEvent(pair.from);
    const toTime = fromTime ? detectRiseStartEvent(pair.to, fromTime) : detectRiseStartEvent(pair.to);

    const resultEl = document.getElementById("flowResult");

    const fromConnected = isStationConnected(pair.from);
    const toConnected = isStationConnected(pair.to);

    const fromTimeText = fromTime ? formatClockDateTime(fromTime) : "Chưa phát hiện đợt dâng";
    const toTimeText = toTime ? formatClockDateTime(toTime) : "Chưa phát hiện đợt dâng";

    let metricsHtml = "";
    let noteHtml = "";

    if (!fromConnected || !toConnected) {
        noteHtml = `<p class="flow-result-note">Cần cả hai trạm (${fromMeta.name}, ${toMeta.name}) có dữ liệu thật để ước tính tốc độ truyền lũ. Trạm chưa kết nối sẽ không có dữ liệu để phân tích.</p>`;
    } else if (!fromTime || !toTime) {
        noteHtml = `<p class="flow-result-note">Chưa đủ dữ liệu: hệ thống cần phát hiện được đợt dâng ở ${fromMeta.name} và một đợt dâng tương ứng xảy ra sau đó ở ${toMeta.name} thì mới tự động tính được thời gian truyền lũ.</p>`;
    } else if (toTime.getTime() < fromTime.getTime()) {
        noteHtml = `<p class="flow-result-note">${toMeta.name} bắt đầu dâng trước ${fromMeta.name} — không phù hợp với chiều truyền lũ ${fromMeta.name} → ${toMeta.name} đang chọn. Vui lòng kiểm tra lại dữ liệu.</p>`;
    } else {
        const timeDiffMs = toTime.getTime() - fromTime.getTime();
        const timeDiffHours = timeDiffMs / 3600000;
        const speedKmh = timeDiffHours > 0 ? distanceKm / timeDiffHours : null;

        metricsHtml = `
            <div class="flow-result-metrics">
                <div class="flow-result-metric">
                    <span class="flow-result-metric-label">🕒 Thời gian truyền</span>
                    <p class="flow-result-metric-value">${formatDurationMinutes(timeDiffMs)}</p>
                </div>
                <div class="flow-result-metric">
                    <span class="flow-result-metric-label">🚀 Tốc độ ước tính</span>
                    <p class="flow-result-metric-value">${speedKmh != null && Number.isFinite(speedKmh) ? `${speedKmh.toFixed(2)} km/h` : "--"}</p>
                </div>
                <div class="flow-result-metric">
                    <span class="flow-result-metric-label">📏 Khoảng cách</span>
                    <p class="flow-result-metric-value">${distanceKm.toFixed(1)} km</p>
                </div>
            </div>
        `;
    }

    const fromBadge = fromTime
        ? `<span class="flow-result-badge is-done">✔ Đã phát hiện đợt dâng</span>`
        : `<span class="flow-result-badge">⏳ Đang theo dõi</span>`;
    const toBadge = toTime
        ? `<span class="flow-result-badge is-done">✔ Đã phát hiện đợt dâng</span>`
        : `<span class="flow-result-badge">⏳ Đang theo dõi</span>`;

    resultEl.innerHTML = `
        <div class="flow-result-route">
            <div class="flow-result-station">
                <span>
                    <span class="status-dot is-${fromConnected ? "online" : "unknown"}" aria-hidden="true"></span>
                    ${fromMeta.name}
                    <span class="flow-result-station-time">${fromTimeText}</span>
                </span>
            </div>
            <span class="flow-result-arrow" aria-hidden="true">→</span>
            <div class="flow-result-station">
                <span>
                    <span class="status-dot is-${toConnected ? "online" : "unknown"}" aria-hidden="true"></span>
                    ${toMeta.name}
                    <span class="flow-result-station-time">${toTimeText}</span>
                </span>
            </div>
        </div>
        <div class="flow-result-route" style="justify-content: center; gap: 24px;">
            ${fromBadge}
            ${toBadge}
        </div>
        ${metricsHtml}
        ${noteHtml}
    `;
}

function formatClockDateTime(date) {
    const hh = String(date.getHours()).padStart(2, "0");
    const mi = String(date.getMinutes()).padStart(2, "0");
    const ss = String(date.getSeconds()).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    const mo = String(date.getMonth() + 1).padStart(2, "0");
    const y = date.getFullYear();
    return `${hh}:${mi}:${ss} ${d}/${mo}/${y}`;
}

// ------------------------------------------------------------
// SỰ KIỆN GIAO DIỆN - ƯỚC TÍNH TỐC ĐỘ TRUYỀN LŨ
// ------------------------------------------------------------
const editDistancesBtn = document.getElementById("editDistancesBtn");
const distanceEditor = document.getElementById("distanceEditor");
const distanceInput12 = document.getElementById("distanceInput-1-2");
const distanceInput23 = document.getElementById("distanceInput-2-3");
const saveDistancesBtn = document.getElementById("saveDistancesBtn");
const flowPairTabs = document.querySelectorAll(".flow-pair-tab");

editDistancesBtn.addEventListener("click", () => {
    const isHidden = distanceEditor.hidden;
    distanceEditor.hidden = !isHidden;
    if (isHidden) {
        distanceInput12.value = state.distances["1-2"].toFixed(1);
        distanceInput23.value = state.distances["2-3"].toFixed(1);
    }
});

saveDistancesBtn.addEventListener("click", () => {
    const d12 = parseFloat(distanceInput12.value);
    const d23 = parseFloat(distanceInput23.value);
    if (!Number.isFinite(d12) || d12 <= 0 || !Number.isFinite(d23) || d23 <= 0) {
        alert("Vui lòng nhập khoảng cách hợp lệ (lớn hơn 0) cho cả hai cặp trạm.");
        return;
    }
    set(distancesRef, { "1-2": d12, "2-3": d23 })
        .then(() => {
            state.distances = { "1-2": d12, "2-3": d23 };
            flashSaved(saveDistancesBtn);
            renderFlowSpeedPanel();
        })
        .catch((error) => console.error("Lỗi khi lưu khoảng cách giữa các trạm:", error));
});

flowPairTabs.forEach((btn) => {
    btn.addEventListener("click", () => {
        state.activeFlowPair = btn.dataset.pair;
        flowPairTabs.forEach((b) => {
            const active = b === btn;
            b.classList.toggle("is-active", active);
            b.setAttribute("aria-pressed", active ? "true" : "false");
        });
        renderFlowSpeedPanel();
    });
});

// ------------------------------------------------------------
// GHI FIREBASE (giữ hành vi/log tương tự bản gốc, áp dụng theo trạm)
// ------------------------------------------------------------
function saveConfiguration(configurationRef, warningLevel) {
    update(configurationRef, { WarningLevel: warningLevel, LastUpdated: new Date().toISOString() })
        .then(() => console.log("Đã lưu configuration:", warningLevel))
        .catch((error) => console.error("Lỗi khi lưu configuration:", error));
}

// Quy đổi "Cảnh báo mức 3" (đơn vị: mực nước DÂNG so với mốc tham chiếu)
// ngược về "khoảng cách cảm biến" mà ESP32 hiểu, rồi ghi đúng field
// Stations/<stationId>/FloodSystem/WarningLevel như cơ chế cũ.
//   rise = initialLevel - distance  =>  distance = initialLevel - rise
function syncHardwareWarningLevel(stationId, floodRef, initialLevel, level3) {
    let distanceThreshold = initialLevel - level3;
    if (!Number.isFinite(distanceThreshold) || distanceThreshold < MIN_HARDWARE_THRESHOLD) {
        console.warn(
            `[${stationId}] "Mực nước tham chiếu" (${initialLevel} m) trừ "Cảnh báo mức 3" (${level3} m) = ` +
                `${Number(distanceThreshold).toFixed(2)} m, không hợp lệ để làm ngưỡng cảm biến cho ESP32 (phải > 0). ` +
                `Đã ghim tạm về ${MIN_HARDWARE_THRESHOLD} m. Hãy đặt lại "Mực nước tham chiếu" cho khớp với chiều cao lắp ` +
                `cảm biến thực tế.`
        );
        distanceThreshold = MIN_HARDWARE_THRESHOLD;
    }
    update(floodRef, { WarningLevel: distanceThreshold })
        .then(() => console.log(`[${stationId}] Đã đồng bộ ngưỡng phần cứng FloodSystem/WarningLevel:`, distanceThreshold))
        .catch((error) => console.error(`[${stationId}] Lỗi khi đồng bộ ngưỡng phần cứng:`, error));
    const { configuration } = stationRefs(stationId);
    saveConfiguration(configuration, distanceThreshold);
}

function pushDefaultWebSettings(stationId, webSettingsRef) {
    const defaults = {
        InitialLevel: DEFAULT_INITIAL_LEVEL,
        AlertLevels: { ...DEFAULT_ALERT_LEVELS },
    };
    set(webSettingsRef, defaults)
        .then(() => console.log(`Đã khởi tạo WebSettings/${stationId} mặc định:`, defaults))
        .catch((error) => console.error(`Lỗi khi khởi tạo WebSettings mặc định (${stationId}):`, error));
}

// Dọn dẹp Measurement cũ theo từng trạm - PORT NGUYÊN VẸN logic từ bản
// gốc, chỉ đổi sang tham chiếu theo stationId.
async function cleanupOldMeasurements(stationId, measurementRef) {
    const s = state.stations[stationId];
    if (s.isCleaningUp) return;
    s.isCleaningUp = true;
    try {
        const snapshot = await get(measurementRef);
        const data = snapshot.val();
        if (!data) {
            s.isCleaningUp = false;
            return;
        }
        const keys = Object.keys(data).sort();
        if (keys.length > MAX_MEASUREMENTS) {
            const keysToDelete = keys.slice(0, keys.length - MAX_MEASUREMENTS);
            const updates = {};
            keysToDelete.forEach((key) => {
                updates[key] = null;
            });
            await update(measurementRef, updates);
            console.log(
                `[${stationId}] Đã xóa ${keysToDelete.length} bản ghi Measurement cũ, giữ lại ${MAX_MEASUREMENTS} bản ghi mới nhất.`
            );
        }
    } catch (error) {
        console.error(`[${stationId}] Lỗi khi dọn dẹp Measurement:`, error);
    } finally {
        s.isCleaningUp = false;
    }
}

// ------------------------------------------------------------
// LẮNG NGHE FIREBASE (theo từng trạm)
// ------------------------------------------------------------
onValue(connectedRef, (snapshot) => {
    state.firebaseConnected = snapshot.val() === true;
    renderHeaderStatus();
});

onValue(distancesRef, (snapshot) => {
    const data = snapshot.val();
    if (!data) {
        if (!state.distancesInitialized) {
            state.distancesInitialized = true;
            set(distancesRef, { ...DEFAULT_DISTANCES }).catch((error) =>
                console.error("Lỗi khi khởi tạo khoảng cách mặc định giữa các trạm:", error)
            );
        }
        return;
    }
    state.distancesInitialized = true;
    const d12 = Number(data["1-2"]);
    const d23 = Number(data["2-3"]);
    state.distances = {
        "1-2": Number.isFinite(d12) ? d12 : DEFAULT_DISTANCES["1-2"],
        "2-3": Number.isFinite(d23) ? d23 : DEFAULT_DISTANCES["2-3"],
    };
    renderHomeIfActive();
});

STATION_IDS.forEach((stationId) => {
    if (!isStationConnected(stationId)) {
        // Trạm chưa có phần cứng thật: không lắng nghe Firebase, chỉ
        // render trạng thái "chưa kết nối" tĩnh khi cần.
        return;
    }

    const { flood, measurement, configuration, webSettings } = stationRefs(stationId);

    onValue(flood, (snapshot) => {
        const data = snapshot.val();
        const s = state.stations[stationId];

        if (!data) {
            s.distance = null;
            s.outOfRange = false;
            s.lastUpdateRaw = null;
            if (state.currentViewId === stationId) renderStation(stationId);
            renderHeaderStatus();
            renderHomeIfActive();
            return;
        }

        const distance = Number(data.WaterLevel);
        const outOfRange = isOutOfRange(distance);
        const changed = s.distance === null || distance !== s.distance || outOfRange !== s.outOfRange;

        s.distance = distance;
        s.outOfRange = outOfRange;
        s.lastUpdateRaw = data.LastUpdate || null;
        s.lastReceivedAt = Date.now();

        if (changed && !outOfRange) {
            // Dùng đúng thời điểm ĐO THỰC TẾ (LastUpdate do ESP32 gửi kèm),
            // không dùng thời điểm trình duyệt NHẬN được dữ liệu qua Firebase
            // (có thể trễ hơn vài giây do độ trễ mạng). Điều này đặc biệt
            // quan trọng cho "Ước tính tốc độ truyền lũ": nếu dùng nhầm thời
            // điểm nhận, chênh lệch thời gian giữa 2 trạm sẽ bị sai lệch và
            // suy ra tốc độ vô lý. Chỉ fallback về thời điểm nhận khi ESP32
            // không gửi kèm timestamp hợp lệ.
            const measuredAt = parseVNDateTimeToDate(s.lastUpdateRaw) || new Date();
            const newPoint = { t: measuredAt, distance, rise: computeRise(distance, s.initialLevel) };
            s.history.push(newPoint);
            s.history.sort((a, b) => a.t.getTime() - b.t.getTime());
            if (s.history.length > CLIENT_HISTORY_LIMIT) s.history.shift();

            // Sao lưu điểm đo mới sang Google Sheets (nếu đã cấu hình URL) -
            // chỉ chạy khi web đang mở, không chặn luồng chính nếu lỗi mạng.
            sendToGoogleSheetsBackup(stationId, newPoint);
        }

        if (changed) cleanupOldMeasurements(stationId, measurement);

        if (state.currentViewId === stationId) {
            renderStation(stationId);
            renderChartForStation(stationId);
            renderPredictionForStation(stationId);
        }
        renderHeaderStatus();
        renderHomeIfActive();
    });

    onValue(webSettings, (snapshot) => {
        const data = snapshot.val();
        const s = state.stations[stationId];

        if (!data) {
            if (!s.webSettingsInitialized) {
                s.webSettingsInitialized = true;
                pushDefaultWebSettings(stationId, webSettings);
            }
            return;
        }
        s.webSettingsInitialized = true;

        const initialLevel = Number(data.InitialLevel);
        s.initialLevel = Number.isFinite(initialLevel) ? initialLevel : DEFAULT_INITIAL_LEVEL;

        const lv = data.AlertLevels || {};
        s.alertLevels = {
            level1: Number.isFinite(Number(lv.level1)) ? Number(lv.level1) : DEFAULT_ALERT_LEVELS.level1,
            level2: Number.isFinite(Number(lv.level2)) ? Number(lv.level2) : DEFAULT_ALERT_LEVELS.level2,
            level3: Number.isFinite(Number(lv.level3)) ? Number(lv.level3) : DEFAULT_ALERT_LEVELS.level3,
        };

        recomputeHistoryRise(stationId);

        if (state.currentViewId === stationId) {
            renderStation(stationId);
            renderChartForStation(stationId);
            renderPredictionForStation(stationId);
        }
        renderHomeIfActive();
    });

    // Nạp trước tối đa 5 bản ghi Measurement đang có sẵn trên Firebase để
    // biểu đồ có dữ liệu ngay khi mở trang, thay vì phải chờ có cập nhật
    // realtime mới rồi mới bắt đầu vẽ.
    get(measurement)
        .then((snapshot) => {
            const data = snapshot.val();
            if (!data) return;
            const s = state.stations[stationId];
            const rawPoints = Object.keys(data)
                .sort()
                .map((key) => {
                    const rec = data[key] || {};
                    const parsedT = parseVNDateTimeToDate(rec.Timestamp);
                    const distance = Number(rec.WaterLevel);
                    return { parsedT, distance };
                })
                .filter((p) => Number.isFinite(p.distance) && p.distance >= 0); // bỏ qua bản ghi ngoài tầm đo (-1)

            const points = rawPoints.map((p) => ({
                t: p.parsedT || new Date(),
                distance: p.distance,
                rise: computeRise(p.distance, s.initialLevel),
            }));

            s.history.unshift(...points);
            if (state.currentViewId === stationId) renderChartForStation(stationId);
            renderHomeIfActive();

            // "Bù dữ liệu" sang Google Sheets: dùng LẠI đúng dữ liệu vừa
            // tải ở trên, chỉ lọc chặt hơn (bỏ luôn bản ghi không có
            // Timestamp hợp lệ - KHÔNG dùng thời gian fallback như trên,
            // vì gửi sai thời điểm đo sẽ làm sai khoá chống trùng ở Apps
            // Script và làm sai dữ liệu lưu trữ dài hạn).
            const backfillPoints = rawPoints
                .filter((p) => p.parsedT !== null)
                .map((p) => ({ t: p.parsedT, distance: p.distance, rise: computeRise(p.distance, s.initialLevel) }));
            pendingBackfillByStation[stationId] = backfillPoints;
            if (backupState.webAppUrl) backfillBackupForStation(stationId, backfillPoints);
        })
        .catch((error) => console.error(`[${stationId}] Lỗi khi tải lịch sử Measurement:`, error));
});

// Kiểm tra định kỳ độ mới của dữ liệu để tự chuyển "Mất kết nối" ngay
// cả khi không có sự kiện Firebase mới nào xảy ra.
setInterval(() => {
    renderHeaderStatus();
    if (state.currentViewId !== "home" && isStationConnected(state.currentViewId)) {
        renderStation(state.currentViewId);
    }
    if (state.currentViewId === "home") {
        renderOverviewCards();
        renderStationStatusTable();
    }
}, 5000);

// ------------------------------------------------------------
// KHỞI ĐỘNG
// ------------------------------------------------------------
console.log("Firebase đã kết nối thành công! (script.js - Giai đoạn 4: Đa trạm + Trang chủ)");
STATION_IDS.forEach((stationId) => renderStation(stationId));
renderHeaderStatus();
renderHome();
