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
// Độ lệch (ms) giữa đồng hồ máy chủ Firebase và đồng hồ máy tính đang mở
// web. Dùng để quy đổi "UpdatedAt" (giờ máy chủ, do ESP32 ghi bằng
// {".sv":"timestamp"}) sang tuổi dữ liệu chính xác - không phụ thuộc đồng
// hồ máy tính hay đồng hồ ESP32 lệch nhau.
const serverTimeOffsetRef = ref(database, ".info/serverTimeOffset");
let serverTimeOffsetMs = 0;
function serverNow() {
    return Date.now() + serverTimeOffsetMs;
}

function getChartHistory(stationId, scope) {
    const clearedThrough = state.chartHistoryClearThrough[scope][stationId];
    const history = state.stations[stationId].history;
    return clearedThrough === undefined
        ? history
        : history.filter((point) => point.t.getTime() > clearedThrough);
}

function clearChartHistory(stationId = null) {
    const scope = stationId ? "stations" : "home";
    const stationIds = stationId ? [stationId] : STATION_IDS;

    stationIds.forEach((id) => {
        const history = state.stations[id].history;
        const latestTimestamp = history.reduce(
            (latest, point) => Math.max(latest, point.t.getTime()),
            serverNow()
        );
        const previousCutoff = state.chartHistoryClearThrough[scope][id];
        state.chartHistoryClearThrough[scope][id] =
            previousCutoff === undefined ? latestTimestamp : Math.max(previousCutoff, latestTimestamp);
    });

    if (stationId) {
        stationCharts[stationId].resetZoom();
        renderChartForStation(stationId);
    } else {
        homeChart.resetZoom();
        renderHomeChart();
    }
}

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

// CHU KỲ ĐO (phút) do người dùng đặt trên Web cho từng trạm, lưu tại
// Stations/<stationId>/Configuration/MeasureIntervalMin - ESP32 đọc giá trị
// này và áp dụng cho các chu kỳ đo kế tiếp (không cần sửa/nạp lại code).
// Giới hạn và mặc định PHẢI trùng với MIN/MAX/DEFAULT_MEASURE_INTERVAL_MIN
// trong code ESP32 (DoAnTN_Tram01.ino).
const DEFAULT_MEASURE_INTERVAL_MIN = 5;
const MIN_MEASURE_INTERVAL_MIN = 1;
const MAX_MEASURE_INTERVAL_MIN = 1440; // 24 giờ

// Ngưỡng "mất kết nối/dữ liệu cũ" giờ TỰ THAY ĐỔI theo chu kỳ đo của từng
// trạm (xem staleMsFor) thay vì cố định 30s: quá (1.5 x chu kỳ + 30s) không có
// dữ liệu mới -> coi là mất kết nối. 30s dôi ra bù cho thời gian ESP32 đo
// 10 lần (~1-2s) + gửi Firebase (vài giây, lâu hơn qua 4G).
const STALE_GRACE_MS = 30 * 1000;
function staleMsFor(s) {
    let minutes = Number.isFinite(s.measureIntervalMin) ? s.measureIntervalMin : DEFAULT_MEASURE_INTERVAL_MIN;
    // Vừa đổi chu kỳ đo trên Web: ESP32 cần tới ~30s mới đọc được giá trị
    // mới, và lần đo kế tiếp vẫn có thể tính theo chu kỳ CŨ. Trong khoảng đó
    // dùng chu kỳ lớn hơn (cũ/mới) để không báo "Mất kết nối" sai ngay sau
    // khi người dùng giảm chu kỳ đo (ví dụ 5 phút -> 1 phút).
    if (s.intervalGraceUntil && Date.now() < s.intervalGraceUntil && Number.isFinite(s.prevMeasureIntervalMin)) {
        minutes = Math.max(minutes, s.prevMeasureIntervalMin);
    }
    return minutes * 60 * 1000 * 1.5 + STALE_GRACE_MS;
}

// Tuổi dữ liệu của trạm (ms) = bây giờ - lần cuối THIẾT BỊ gửi lên.
//   - Firmware mới: có "UpdatedAt" (giờ MÁY CHỦ Firebase lúc nhận) ->
//     tuổi = serverNow() - UpdatedAt. Đúng ngay cả khi vừa mở trang (dữ liệu
//     cũ từ hôm trước sẽ bị nhận ra là cũ), và KHÔNG bị ảnh hưởng khi chính
//     Web ghi WarningLevel vào FloodSystem (Web không đụng tới UpdatedAt).
//   - Firmware cũ (không có UpdatedAt): dùng thời điểm trình duyệt nhận
//     được một lần gửi MỚI của thiết bị (Seq/LastUpdate thay đổi) - xem
//     onValue(flood, ...).
function stationDataAgeMs(s) {
    if (Number.isFinite(s.deviceUpdatedAt)) return serverNow() - s.deviceUpdatedAt;
    if (s.lastReceivedAt) return Date.now() - s.lastReceivedAt;
    return Infinity;
}

const MIN_HARDWARE_THRESHOLD = 0.05; // ngưỡng khoảng cách tối thiểu hợp lệ gửi cho ESP32 (m)

const DEFAULT_INITIAL_LEVEL = 0.5;
const DEFAULT_ALERT_LEVELS = { level1: 0.5, level2: 0.8, level3: 1.0 };
const DEFAULT_DISTANCES = { "1-2": 5.0, "2-3": 7.0 }; // km - chỉnh được trên giao diện, không hard-code cố định
// GHI CHÚ (đã bỏ ngưỡng cố định người dùng nhập): trước đây có
// DEFAULT_RISE_THRESHOLD (m) để người dùng tự chọn "mức dâng cần đạt"
// trước khi tính tốc độ truyền lũ. Theo yêu cầu mới, KHÔNG còn ngưỡng cố
// định nào cả - xem findRiseCrossingTime() bên dưới: mỗi khi trạm nguồn
// đạt một mức dâng CAO NHẤT MỚI (so với mọi điểm đo trước đó của chính
// nó), hệ thống tự lấy đúng giá trị đó làm mức cần so sánh với trạm đích,
// không cần người dùng nhập tay nữa.

const RANGE_MS = {
    "6h": 6 * 3600 * 1000,
    "12h": 12 * 3600 * 1000,
    "24h": 24 * 3600 * 1000,
    "7d": 7 * 24 * 3600 * 1000,
};

// Khoảng trống tối thiểu (10 phút) để ngắt đường nối trên biểu đồ; với chu kỳ
// đo dài hơn, ngưỡng này tự nới ra thành 2.5 x chu kỳ (xem chartGapMsFor) -
// nếu không, mọi điểm cách nhau > 10 phút sẽ bị ngắt và không có đường nối.
const MIN_CHART_GAP_MS = 10 * 60 * 1000;
function chartGapMsFor(intervalMin) {
    const minutes = Number.isFinite(intervalMin) ? intervalMin : DEFAULT_MEASURE_INTERVAL_MIN;
    return Math.max(MIN_CHART_GAP_MS, minutes * 60 * 1000 * 2.5);
}

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
// LƯU Ý QUAN TRỌNG (đã sửa): "hasHardware" KHÔNG còn hard-code cố định ở
// đây nữa. Trước đây Trạm 2/3 bị gán cứng false nên web không bao giờ
// lắng nghe Firebase (onValue) cho các trạm đó, dẫn tới việc dù ESP32 đã
// nạp code và gửi dữ liệu thật lên đúng nhánh Stations/station-2/... thì
// web vẫn luôn hiển thị "Chưa kết nối" và khoá toàn bộ input/nút SET.
// Giờ đây MỌI trạm trong STATION_IDS đều được lắng nghe Firebase như
// nhau; trạng thái "đã kết nối" được xác định ĐỘNG dựa trên việc trạm đó
// đã từng nhận được dữ liệu FloodSystem thật hay chưa - xem
// state.stations[id].hasReceivedData và hàm isStationConnected() bên dưới.
const STATION_META = {
    "station-1": { name: "Trạm 1", deviceId: "ESP32-STATION-01", color: "#2196f3" },
    "station-2": { name: "Trạm 2", deviceId: "ESP32-STATION-02", color: "#00a651" },
    "station-3": { name: "Trạm 3", deviceId: "--", color: "#d9534f" },
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
        lastReceivedAt: null, // Date.now() lúc web nhận được một lần gửi MỚI của thiết bị (dự phòng cho firmware cũ)
        deviceUpdatedAt: null, // FloodSystem/UpdatedAt - giờ máy chủ Firebase (ms) lúc thiết bị gửi lần cuối
        deviceStamp: null, // "Seq|LastUpdate|UpdatedAt" của lần gửi gần nhất - để phân biệt thiết bị gửi mới với Web tự ghi WarningLevel
        prevMeasureIntervalMin: null, // chu kỳ đo trước khi đổi (xem staleMsFor)
        intervalGraceUntil: 0,
        initialLevel: DEFAULT_INITIAL_LEVEL, // mực nước tham chiếu
        alertLevels: { ...DEFAULT_ALERT_LEVELS },
        history: [], // [{ t: Date, distance: number, rise: number }] - dùng vẽ biểu đồ/dự đoán/ước tính tốc độ
        webSettingsInitialized: false,
        isCleaningUp: false,
        // true ngay khi Firebase trả về node Stations/<id>/FloodSystem có dữ
        // liệu thật (khác null) LẦN ĐẦU TIÊN - đây là cách web tự phát hiện
        // "trạm này đã có ESP32 thật đang gửi dữ liệu", KHÔNG hard-code nữa.
        hasReceivedData: false,
        // Chu kỳ đo (phút) hiện đang áp dụng cho trạm này - đồng bộ từ
        // Stations/<id>/Configuration/MeasureIntervalMin (xem onValue bên dưới).
        // Chưa đặt trên Firebase => dùng mặc định (trùng mặc định của ESP32).
        measureIntervalMin: DEFAULT_MEASURE_INTERVAL_MIN,
    };
}

const state = {
    currentViewId: "home",
    activeRange: "6h", // dùng chung cho biểu đồ trang chủ + từng trạm (đơn giản hoá, đồng bộ mốc thời gian)
    firebaseConnected: false,
    activeFlowPair: "1-2",
    // Kết quả tốc độ truyền lũ GẦN NHẤT đã tính được cho từng cặp trạm.
    // Được giữ nguyên (và hiển thị) cho tới khi có kết quả MỚI thay thế.
    // Đồng bộ với Firebase: WebSettings/FlowSpeedResults/<pairKey> để không mất khi F5.
    // Mỗi phần tử: { fromTime, toTime, targetRise, refDistance, computedAt } | null
    flowResults: { "1-2": null, "2-3": null, "1-3": null },
    distances: { ...DEFAULT_DISTANCES },
    distancesInitialized: false,
    chartHistoryClearThrough: { home: {}, stations: {} },
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
        measureInterval: ref(database, `Stations/${stationId}/Configuration/MeasureIntervalMin`),
        webSettings: ref(database, `WebSettings/${stationId}`),
    };
}

const distancesRef = ref(database, "WebSettings/StationDistances");
const flowResultsRef = ref(database, "WebSettings/FlowSpeedResults");

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

// QUAN TRỌNG (sửa lỗi "biểu đồ trang chủ hiện sai/trục thời gian kéo dài
// bất thường"): sau khi bỏ việc ép cứng scales.x.min/max, biểu đồ tự co
// giãn theo đúng min/max của DỮ LIỆU THẬT - nhưng nếu có dù chỉ 1 điểm với
// mốc thời gian bị lỗi (ví dụ đồng hồ ESP32/RTC chưa đồng bộ, hoặc dữ liệu
// cũ còn sót với ngày tháng sai) rơi vào TƯƠNG LAI so với đồng hồ trình
// duyệt, bộ lọc "age = now - t <= rangeMs" ở renderChartForStation()/
// renderHomeChart() KHÔNG loại được nó - vì age khi đó ÂM, luôn <= rangeMs
// (dương) dù chênh lệch thực tế lên tới hàng chục giờ. Một điểm "tương lai"
// duy nhất như vậy đủ để kéo giãn toàn bộ trục X ra rất xa, ép mọi điểm
// thật còn lại dồn cục vào một góc - đúng hiện tượng bạn thấy ở biểu đồ
// trang chủ (Trạm 2/3 hiện tách biệt hẳn xa bên phải).
// Cho phép sai lệch nhỏ (vài phút) giữa đồng hồ ESP32 và trình duyệt do độ
// trễ mạng, nhưng KHÔNG chấp nhận mốc thời gian ở tương lai xa - dữ liệu đo
// không thể "đến từ tương lai".
const FUTURE_TOLERANCE_MS = 2 * 60 * 1000;
function isPlausibleMeasurementTime(date) {
    return date instanceof Date && !isNaN(date.getTime()) && date.getTime() <= Date.now() + FUTURE_TOLERANCE_MS;
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
    return stationDataAgeMs(s) <= staleMsFor(s);
}

function isStationConnected(stationId) {
    return state.stations[stationId].hasReceivedData;
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

const chartZoomPlugin = window.zoomPlugin || window.ChartZoom || window["chartjs-plugin-zoom"];
if (chartZoomPlugin) Chart.register(chartZoomPlugin);

const chartZoomOptions = {
    zoom: {
        wheel: {
            enabled: true,
            speed: 0.1,
        },
        mode: "xy",
    },
    pan: {
        enabled: true,
        mode: "xy",
        threshold: 4,
    },
};

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
        zoomResetBtn: root.querySelector('[data-field="zoomResetBtn"]'),
        clearHistoryBtn: root.querySelector('[data-field="clearHistoryBtn"]'),
        chartEmptyNote: root.querySelector('[data-field="chartEmptyNote"]'),
        waterChartCanvas: root.querySelector('[data-field="waterChart"]'),
        alertLevel1Input: root.querySelector('[data-field="alertLevel1Input"]'),
        alertLevel2Input: root.querySelector('[data-field="alertLevel2Input"]'),
        alertLevel3Input: root.querySelector('[data-field="alertLevel3Input"]'),
        alertLevel1SetBtn: root.querySelector('[data-field="alertLevel1SetBtn"]'),
        alertLevel2SetBtn: root.querySelector('[data-field="alertLevel2SetBtn"]'),
        alertLevel3SetBtn: root.querySelector('[data-field="alertLevel3SetBtn"]'),
        measureIntervalInput: root.querySelector('[data-field="measureIntervalInput"]'),
        measureIntervalSetBtn: root.querySelector('[data-field="measureIntervalSetBtn"]'),
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
                // QUAN TRỌNG (sửa lỗi "mốc thời gian trên biểu đồ bị sai"):
                // TRƯỚC ĐÂY trục X dùng "labels" dạng chuỗi (category scale
                // mặc định của Chart.js) - loại trục này chia đều khoảng
                // cách theo THỨ TỰ điểm, không theo THỜI GIAN THỰC, nên 2
                // điểm cách nhau 15 giây và 2 điểm cách nhau 1 giờ sẽ hiển
                // thị with khoảng cách bằng nhau trên biểu đồ. Đổi sang trục
                // số thực (linear) dùng đúng mốc thời gian (mili-giây) làm
                // toạ độ X, rồi format lại thành giờ:phút:giây khi hiển thị
                // nhãn - đảm bảo vị trí điểm trên trục phản ánh đúng thời
                // gian đo thực tế.
                x: {
                    type: "linear",
                    ticks: {
                        callback: (value) => formatChartLabel(new Date(value), state.activeRange),
                    },
                },
                y: {
                    title: { display: true, text: "Mức nước dâng (m)" },
                },
            },
            plugins: {
                zoom: chartZoomOptions,
                tooltip: {
                    callbacks: {
                        title: (items) => (items[0] ? new Date(items[0].parsed.x).toLocaleString("vi-VN") : ""),
                    },
                },
            },
        },
    });

    // Sự kiện giao diện riêng cho trạm này
    els.chartRangeTabs.querySelectorAll(".range-tab").forEach((btn) => {
        btn.addEventListener("click", () => setActiveRange(btn.dataset.range));
    });

    els.zoomResetBtn.addEventListener("click", () => stationCharts[stationId].resetZoom());
    els.clearHistoryBtn.addEventListener("click", () => clearChartHistory(stationId));

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
                if (isStationConnected(stationId)) {
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
                if (isStationConnected(stationId)) {
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

    // ------------------------------------------------------------
    // CHU KỲ ĐO (phút): ghi lên Firebase để ESP32 đọc và áp dụng cho các
    // chu kỳ đo kế tiếp. Chu kỳ đo = khoảng thời gian giữa 2 KẾT QUẢ ĐO
    // CHÍNH THỨC (mỗi kết quả là trung bình 10 lần đo nội bộ trên ESP32),
    // KHÔNG phải khoảng cách giữa các lần đo nội bộ.
    // ------------------------------------------------------------
    els.measureIntervalSetBtn.addEventListener("click", () => {
        const val = parseFloat(els.measureIntervalInput.value);
        if (!Number.isInteger(val) || val < MIN_MEASURE_INTERVAL_MIN || val > MAX_MEASURE_INTERVAL_MIN) {
            els.measureIntervalInput.setCustomValidity(
                `Nhập số phút nguyên từ ${MIN_MEASURE_INTERVAL_MIN} đến ${MAX_MEASURE_INTERVAL_MIN}.`
            );
            els.measureIntervalInput.reportValidity();
            return;
        }
        els.measureIntervalInput.setCustomValidity("");

        const { measureInterval } = stationRefs(stationId);
        set(measureInterval, val)
            .then(() => {
                // state.stations[..].measureIntervalMin đã được onValue(measureInterval) cập nhật
                flashSaved(els.measureIntervalSetBtn);
                renderStation(stationId);
                renderChartForStation(stationId);
                renderHomeIfActive();
            })
            .catch((error) => console.error(`Lỗi khi lưu chu kỳ đo (${stationId}):`, error));
    });

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
const homeChartZoomResetBtn = document.getElementById("homeChartZoomResetBtn");
const homeChartClearHistoryBtn = document.getElementById("homeChartClearHistoryBtn");

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
            spanGaps: false,
        })),
    },
    options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: true,
        scales: {
            // Giống biểu đồ từng trạm: trục X dùng mốc thời gian thực
            // (linear) thay vì category theo danh sách nhãn gộp - trước đây
            // gộp mốc thời gian của cả 3 trạm thành 1 mảng "labels" dùng
            // chung rồi chia đều theo THỨ TỰ, khiến vị trí của Trạm 2/3 bị
            // lệch so với thời gian thực mỗi khi mật độ đo giữa các trạm
            // khác nhau (xem renderHomeChart()).
            x: {
                type: "linear",
                ticks: {
                    callback: (value) => formatChartLabel(new Date(value), state.activeRange),
                },
            },
            y: {
                title: { display: true, text: "Mức nước dâng (m)" },
            },
        },
        plugins: {
            zoom: chartZoomOptions,
            tooltip: {
                callbacks: {
                    title: (items) => (items[0] ? new Date(items[0].parsed.x).toLocaleString("vi-VN") : ""),
                },
            },
        },
    },
});

homeChartZoomResetBtn.addEventListener("click", () => homeChart.resetZoom());
homeChartClearHistoryBtn.addEventListener("click", () => clearChartHistory());

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
    renderHeaderStatus(); // header giờ phản ánh đúng trang/trạm đang xem
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

function toChartPoints(points, gapMs = MIN_CHART_GAP_MS) {
    const sorted = [...points].sort((a, b) => a.t.getTime() - b.t.getTime());
    const chartPoints = [];

    sorted.forEach((point, index) => {
        if (index > 0) {
            const previous = sorted[index - 1];
            const gap = point.t.getTime() - previous.t.getTime();
            if (gap > gapMs) {
                chartPoints.push({ x: previous.t.getTime() + gap / 2, y: null });
            }
        }
        chartPoints.push({ x: point.t.getTime(), y: point.rise });
    });

    return chartPoints;
}

function renderChartForStation(stationId) {
    if (state.currentViewId !== stationId) return;
    const els = stationEls[stationId];
    const s = state.stations[stationId];
    const rangeMs = RANGE_MS[state.activeRange] ?? RANGE_MS["6h"];
    const now = Date.now();
    // "age >= 0" chặn luôn phòng hờ mọi điểm có mốc thời gian ở TƯƠNG LAI
    // lọt vào s.history (age âm nghĩa là t > now) - dù đã chặn từ gốc lúc
    // nạp dữ liệu (isPlausibleMeasurementTime), giữ thêm lớp chặn này ở đây
    // để không phụ thuộc hoàn toàn vào 1 chỗ kiểm tra duy nhất.
    const points = getChartHistory(stationId, "stations").filter((p) => {
        const age = now - p.t.getTime();
        // SỬA LỖI BIỂU ĐỒ TRỄ 1 NHỊP: trước đây là "age >= 0" - đồng hồ ESP32
        // chỉ cần nhanh hơn đồng hồ máy tính vài giây là điểm đo MỚI NHẤT bị
        // coi là "tương lai" và bị loại (dù đã có trong lịch sử, mực nước hiện
        // tại đã hiển thị). Biểu đồ không vẽ lại cho tới lần nhận dữ liệu kế
        // tiếp -> luôn thiếu đúng điểm mới nhất. Giờ cho phép lệch tới
        // FUTURE_TOLERANCE_MS, trùng với ngưỡng đã dùng khi nhận dữ liệu
        // (isPlausibleMeasurementTime) nên điểm nào đã vào lịch sử đều được vẽ.
        return age >= -FUTURE_TOLERANCE_MS && age <= rangeMs;
    });

    const chart = stationCharts[stationId];
    // Dùng {x, y} với x = mốc thời gian thực (mili-giây) thay vì mảng
    // labels dạng chuỗi - xem giải thích ở phần khởi tạo trục X phía trên.
    //
    // QUAN TRỌNG (đã sửa lỗi mới phát sinh "F5 làm biểu đồ hiện sai/mốc
    // thời gian tự đổi dù không có dữ liệu mới"): Ở LẦN SỬA TRƯỚC, code có
    // ép cứng chart.options.scales.x.min/max = [now - rangeMs, now] ở ĐÂY
    // - tức là MỖI LẦN gọi hàm này (kể cả khi trạm KHÔNG có dữ liệu nào cả,
    // hoặc dữ liệu thật chỉ nằm gọn trong vài phút), trục X vẫn luôn bị kéo
    // dài ra đúng bằng "now" (thời điểm gọi hàm - tức thời điểm F5) tới
    // "now - rangeMs". Hậu quả kép:
    //   1. Với trạm KHÔNG có dữ liệu (points rỗng), trục X vẫn hiện đủ nhãn
    //      giờ chạy tới đúng "bây giờ" - tạo cảm giác sai là "có mốc thời
    //      gian mới" dù không hề có điểm đo nào.
    //   2. Với trạm CÓ dữ liệu nhưng khoảng thời gian đo thực tế hẹp hơn
    //      nhiều so với rangeMs (ví dụ tab "6 giờ" nhưng dữ liệu chỉ trải
    //      dài 20 phút), toàn bộ dữ liệu thật bị dồn ép vào một góc nhỏ của
    //      biểu đồ, phần còn lại là khoảng trắng vô nghĩa - nhìn khác hẳn
    //      (và "sai" hơn) so với trước khi sửa.
    // Sửa: bỏ hẳn việc ép min/max theo "now" - để Chart.js TỰ co giãn trục X
    // theo đúng khoảng thời gian của DỮ LIỆU THẬT đang có (points đã được
    // lọc theo đúng tab 6 giờ/12 giờ/24 giờ/7 ngày ở dòng filter phía trên
    // rồi, không cần ép lại phạm vi trục một lần nữa).
    chart.data.datasets[0].data = toChartPoints(points, chartGapMsFor(s.measureIntervalMin));
    chart.update();

    els.chartEmptyNote.textContent = isStationConnected(stationId)
        ? "Chưa đủ dữ liệu lịch sử cho khoảng thời gian này."
        : `${STATION_META[stationId].name} chưa được kết nối - chưa có dữ liệu lịch sử.`;
    els.chartEmptyNote.hidden = points.length > 0;
}

function renderHomeChart() {
    const rangeMs = RANGE_MS[state.activeRange] ?? RANGE_MS["6h"];
    const now = Date.now();

    // ĐÃ SỬA: trước đây gộp mốc thời gian của cả 3 trạm thành 1 mảng
    // "labels" dùng chung (category scale), rồi map giá trị mỗi trạm vào
    // đúng CHỈ SỐ của mốc đó - vì category scale chia đều khoảng cách
    // theo chỉ số (không theo thời gian thực), trạm nào có mật độ đo khác
    // trạm còn lại sẽ bị hiển thị lệch vị trí thời gian thực (đúng lỗi đã
    // gặp: trạm 2/3 hiện bên phải trạm 1 dù dữ liệu thực tế lại có mốc
    // thời gian sớm hơn hoặc xen kẽ).
    // Giờ mỗi trạm tự có mảng {x, y} riêng với x = mốc thời gian thực -
    // Chart.js tự đặt đúng vị trí theo trục X số (linear) dùng chung cho
    // cả 3 trạm, không cần gộp/tra cứu qua danh sách nhãn chung nữa.
    let hasAnyPoint = false;
    STATION_IDS.forEach((stationId, idx) => {
        const s = state.stations[stationId];
        // "age >= 0" chặn phòng hờ điểm có mốc thời gian ở tương lai - xem
        // giải thích đầy đủ ở renderChartForStation()/isPlausibleMeasurementTime().
        const points = getChartHistory(stationId, "home")
            .filter((p) => {
                const age = now - p.t.getTime();
                return age >= -FUTURE_TOLERANCE_MS && age <= rangeMs; // xem giải thích ở renderChartForStation()
            });
        if (points.length > 0) hasAnyPoint = true;
        homeChart.data.datasets[idx].data = toChartPoints(points, chartGapMsFor(s.measureIntervalMin));
    });
    // Đã bỏ việc ép cứng scales.x.min/max = [now - rangeMs, now] - cùng lý
    // do đã giải thích chi tiết trong renderChartForStation() ở trên: ép
    // trục X luôn kéo dài tới đúng thời điểm gọi hàm (mỗi lần F5) khiến
    // biểu đồ hiện mốc thời gian "ảo" ngay cả khi không có trạm nào có dữ
    // liệu, và dồn ép dữ liệu thật vào một góc nhỏ khi khoảng đo hẹp hơn
    // rangeMs. Để Chart.js tự co giãn trục X theo đúng khoảng thời gian của
    // dữ liệu thật (đã lọc theo đúng tab ở trên).
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
// Đồng bộ ô nhập "Chu kỳ đo (phút)" với state + khoá/mở theo trạng thái kết
// nối. Chỉ cho chỉnh khi trạm đã có ESP32 thật (tránh tạo node Configuration
// cho trạm chưa có phần cứng). Không ghi đè khi người dùng đang gõ dở.
function renderMeasureIntervalControls(stationId) {
    const els = stationEls[stationId];
    const s = state.stations[stationId];
    const connected = isStationConnected(stationId);

    if (document.activeElement !== els.measureIntervalInput) {
        els.measureIntervalInput.value = String(s.measureIntervalMin);
    }
    els.measureIntervalInput.disabled = !connected;
    els.measureIntervalSetBtn.disabled = !connected;
}

function renderStation(stationId) {
    const els = stationEls[stationId];
    const s = state.stations[stationId];
    const meta = STATION_META[stationId];
    const connected = isStationConnected(stationId);

    if (!connected) {
        // Trạm chưa có ESP32 thật -> hiển thị "chưa kết nối" nhưng vẫn cho phép
        // xem lịch sử và chỉnh các thiết lập chỉ dùng trên web.
        els.waterLevel.textContent = "--";
        els.waterLevelUnit.style.display = "none";
        els.waterLevelDelta.hidden = true;

        setSeverityClasses(els.cardSystemStatus, "unknown");
        setSeverityClasses(els.systemStatusDot, "unknown");
        setSeverityClasses(els.systemStatus, "unknown");
        els.systemStatus.textContent = SEVERITY_LABEL.unknown;
        els.statusDescription.textContent = SEVERITY_DESC.notConnected;

        if (document.activeElement !== els.initialLevelInput) {
            els.initialLevelInput.value = s.initialLevel.toFixed(2);
        }
        els.initialLevelInput.placeholder = "";
        els.initialLevelInput.disabled = false;
        els.initialLevelSetBtn.disabled = false;

        [1, 2, 3].forEach((n) => {
            const input = els[`alertLevel${n}Input`];
            if (document.activeElement !== input) {
                input.value = s.alertLevels[`level${n}`].toFixed(2);
            }
            input.placeholder = "";
            input.disabled = false;
            els[`alertLevel${n}SetBtn`].disabled = false;
        });

        els.predictionRange.disabled = true;
        renderMeasureIntervalControls(stationId);
        els.chartRangeTabs.querySelectorAll(".range-tab").forEach((b) => (b.disabled = false));

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
    renderMeasureIntervalControls(stationId);
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
    // SỬA LỖI "Trạm 1 đang online nhưng header báo Mất kết nối": TRƯỚC ĐÂY
    // header luôn gộp CẢ 3 trạm - chỉ cần 1 trạm khác (vd. Trạm 2/3 còn dữ
    // liệu test cũ trên Firebase) bị cũ là header báo "Mất kết nối / dữ liệu
    // cũ" ngay cả khi đang xem Trạm 1 hoạt động bình thường, mâu thuẫn với
    // dòng "Trạng thái kết nối: Đang online" ngay bên dưới.
    // Giờ: đang xem 1 trạm -> header phản ánh ĐÚNG trạm đó; ở Trang chủ ->
    // gộp các trạm và nêu rõ TÊN trạm đang mất kết nối.
    let healthy;
    let text;
    if (!state.firebaseConnected) {
        healthy = false;
        text = "Mất kết nối tới máy chủ Firebase";
    } else if (state.currentViewId !== "home") {
        const id = state.currentViewId;
        if (!isStationConnected(id)) {
            healthy = true;
            text = "Hệ thống hoạt động tốt";
        } else {
            healthy = isStationFresh(state.stations[id]);
            text = healthy ? "Thiết bị đang hoạt động" : `${STATION_META[id].name} mất kết nối / dữ liệu cũ`;
        }
    } else {
        const staleNames = STATION_IDS.filter((id) => isStationConnected(id) && !isStationFresh(state.stations[id])).map(
            (id) => STATION_META[id].name
        );
        healthy = staleNames.length === 0;
        text = healthy ? "Hệ thống hoạt động tốt" : `Mất kết nối: ${staleNames.join(", ")}`;
    }
    const systemHealthDot = document.getElementById("systemHealthDot");
    const systemHealthText = document.getElementById("systemHealthText");
    systemHealthDot.classList.toggle("is-online", healthy);
    systemHealthDot.classList.toggle("is-danger", !healthy);
    systemHealthText.textContent = text;

    // Cập nhật "Cập nhật lần cuối" ở header theo trạm đang xem (nếu là
    // trang chủ, lấy thời điểm mới nhất trong số các trạm đã kết nối).
    if (state.currentViewId === "home") {
        let latest = null;
        STATION_IDS.forEach((id) => {
            const s = state.stations[id];
            const age = stationDataAgeMs(s);
            if (isStationConnected(id) && Number.isFinite(age) && (!latest || age < latest.age)) {
                latest = { age, raw: s.lastUpdateRaw };
            }
        });
        document.getElementById("lastUpdate").textContent = latest ? formatVNDateTime(latest.raw) : "--:--:-- --/--/----";
    }
}

function renderHomeIfActive() {
    // Hàm này được gọi ở MỌI chỗ dữ liệu trạm thay đổi (nhận điểm đo mới,
    // nạp lịch sử, đổi mực tham chiếu/ngưỡng...), BẤT KỂ đang xem trang
    // nào - nên đây là chỗ phù hợp để kiểm tra và GHI NHỚ kết quả tốc độ
    // truyền lũ mới (xem updateFlowResults), không phụ thuộc việc người
    // dùng có đang mở Trang chủ đúng lúc kết quả xuất hiện hay không.
    updateFlowResults();
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
// GHI CHÚ (đã đổi lại hoàn toàn - không còn Min/Max/ngưỡng nào cả):
// Các bản trước có dùng ngưỡng cố định do người dùng chọn, rồi sau đó
// đổi sang "mức dâng CAO NHẤT của trạm nguồn" - nhưng cách dùng "cao
// nhất" có vấn đề thực tế: sau khi qua đỉnh lũ và nước RÚT xuống, giá
// trị cao nhất đó không đổi nữa (vì là max), nên hệ thống bị "kẹt" ở
// đỉnh cũ, không phát hiện được các đợt lũ lên-xuống tiếp theo. Cách
// làm ĐÚNG theo yêu cầu hiện tại, không dùng Min/Max/ngưỡng gì cả:
//   1. Lấy giá trị dâng (rise) tại ĐIỂM ĐO MỚI NHẤT của trạm nguồn (from)
//      - đây là "mức thay đổi" hiện đang được theo dõi, luôn cập nhật
//      theo thời gian thực (kể cả khi nước đang rút, rise giảm dần thì
//      mức đang theo dõi cũng giảm theo, không bị kẹt ở đỉnh cũ).
//   2. Thời điểm trạm nguồn "có mức thay đổi đó" = thời điểm đo mới nhất
//      (chính là điểm vừa lấy ở bước 1).
//   3. Tìm trong lịch sử trạm ĐÍCH (to) điểm đo ĐẦU TIÊN SAU thời điểm đó
//      có giá trị rise gần bằng (trong sai số cho phép RISE_MATCH_TOLERANCE_M)
//      giá trị đã ghi nhận ở trạm nguồn - không cần trùng tuyệt đối vì
//      cảm biến đo số thực liên tục, gần như không bao giờ trùng khớp
//      100%.
//   4. Ngay khi tìm được điểm khớp ở trạm đích, tính tốc độ = khoảng
//      cách / thời gian chênh lệch giữa 2 thời điểm - không cần chờ gì
//      thêm, không kiểm tra rise phải lớn hơn 1 mức tối thiểu nào.
const RISE_MATCH_TOLERANCE_M = 0.03; // 3cm - sai số cho phép để coi 2 giá trị dâng là "khớp nhau"

// ĐIỀU KIỆN TÍNH LẠI TỐC ĐỘ TRUYỀN LŨ (chỉ kiểm soát THỜI ĐIỂM tính lại,
// KHÔNG thay đổi công thức/cách tính):
//   - Sau mỗi lần tính được kết quả, ghi nhớ mực nước (khoảng cách đo) của
//     TRẠM NGUỒN tại thời điểm tính -> refDistance.
//   - Chỉ cho phép tính kết quả MỚI khi mực nước hiện tại của trạm nguồn
//     chênh lệch >= 10 cm so với refDistance.
//   - Chênh lệch < 10 cm -> KHÔNG tính lại, GIỮ NGUYÊN tốc độ đã tính (không
//     xoá, không đặt về 0).
//   - Mỗi lần tính hợp lệ -> cập nhật refDistance = mực nước lúc tính.
// So sánh trên khoảng cách đo thô (không phải mức dâng) để việc đổi "mực
// nước tham chiếu" không làm mốc so sánh bị dịch theo. Vì mức dâng = mực
// tham chiếu - khoảng cách, 10 cm khoảng cách = 10 cm mức dâng.
const FLOW_RECALC_MIN_CHANGE_M = 0.10;

// Chênh lệch tính theo mm (làm tròn) để tránh sai số dấu phẩy động, ví dụ
// |0.60 - 0.50| = 0.09999999999999998 bị hiểu nhầm là < 10 cm.
function levelChangeMm(currentDistance, refDistance) {
    return Math.round(Math.abs(currentDistance - refDistance) * 1000);
}

function isFlowRecalcAllowed(prev, currentDistance) {
    if (!prev || !Number.isFinite(prev.refDistance)) return true; // chưa có mốc (lần tính đầu) -> cho tính
    if (!Number.isFinite(currentDistance)) return false;          // chưa biết mực nước hiện tại -> giữ kết quả cũ
    return levelChangeMm(currentDistance, prev.refDistance) >= Math.round(FLOW_RECALC_MIN_CHANGE_M * 1000);
}

// Tìm điểm đo ĐẦU TIÊN trong history có thời điểm SAU afterTime và có
// rise nằm trong khoảng [targetRise - tolerance, targetRise + tolerance].
function findMatchingRiseAfter(history, targetRise, afterTime, tolerance) {
    const sorted = [...history].sort((a, b) => a.t.getTime() - b.t.getTime());
    for (let i = 0; i < sorted.length; i += 1) {
        const p = sorted[i];
        if (p.t.getTime() <= afterTime.getTime()) continue; // phải xảy ra SAU trạm nguồn
        // So theo mm (làm tròn) để lệch ĐÚNG 3 cm vẫn được tính là khớp (tránh sai số
        // dấu phẩy động, ví dụ |0.33 - 0.30| = 0.030000000000000027 > 0.03).
        if (Math.round(Math.abs(p.rise - targetRise) * 1000) <= Math.round(tolerance * 1000)) return p.t;
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

// ------------------------------------------------------------
// TÍNH "ĐIỂM KHỚP HIỆN TẠI" CHO 1 CẶP TRẠM (logic tính GIỮ NGUYÊN như cũ):
//   - Trạm nguồn: lấy điểm đo MỚI NHẤT -> fromTime (t_A), targetRise (h*)
//   - Trạm đích: điểm đầu tiên SAU t_A có |rise - h*| <= RISE_MATCH_TOLERANCE_M -> toTime (t_B)
// ------------------------------------------------------------
function computeCurrentFlowMatch(pairKey) {
    const pair = FLOW_PAIRS[pairKey];
    const fromState = state.stations[pair.from];
    const toState = state.stations[pair.to];
    const fromConnected = isStationConnected(pair.from);
    const toConnected = isStationConnected(pair.to);

    const fromSorted = fromConnected ? [...fromState.history].sort((a, b) => a.t.getTime() - b.t.getTime()) : [];
    const fromLatest = fromSorted.length ? fromSorted[fromSorted.length - 1] : null;
    const fromTime = fromLatest ? fromLatest.t : null;
    const targetRise = fromLatest ? fromLatest.rise : null;
    const fromDistance = fromLatest ? fromLatest.distance : null; // mực nước (khoảng cách đo) hiện tại của trạm nguồn

    const toTime =
        toConnected && targetRise != null
            ? findMatchingRiseAfter(toState.history, targetRise, fromTime, RISE_MATCH_TOLERANCE_M)
            : null;

    return { fromConnected, toConnected, fromTime, toTime, targetRise, fromDistance };
}

// ------------------------------------------------------------
// GHI NHỚ KẾT QUẢ TỐC ĐỘ TRUYỀN LŨ (SỬA LỖI "kết quả bị mất mỗi khi trạm
// nguồn gửi điểm đo mới"):
// Trước đây kết quả chỉ được TÍNH LẠI rồi vẽ ra mỗi lần render, không được
// lưu ở đâu cả. Vì t_A luôn là điểm MỚI NHẤT của trạm nguồn, ngay khi trạm
// nguồn gửi thêm 1 điểm (kể cả giá trị không đổi), điểm khớp cũ ở trạm đích
// nằm TRƯỚC t_A mới nên bị loại -> kết quả biến mất, quay về "Đang chờ".
// Giờ: mỗi khi tìm được một cặp (t_A, t_B) hợp lệ KHÁC với kết quả đang
// lưu, ghi nó vào state.flowResults[pairKey] + Firebase. Kết quả này được
// HIỂN THỊ LIÊN TỤC cho tới khi có kết quả mới thay thế.
// Hàm được gọi từ renderHomeIfActive() - tức ở MỌI lần dữ liệu thay đổi,
// bất kể đang xem trang nào.
// ------------------------------------------------------------
function updateFlowResults() {
    Object.keys(FLOW_PAIRS).forEach((pairKey) => {
        const m = computeCurrentFlowMatch(pairKey);
        if (!m.fromTime || !m.toTime) return; // chưa có kết quả mới -> GIỮ NGUYÊN kết quả cũ
        const fromMs = m.fromTime.getTime();
        const toMs = m.toTime.getTime();
        if (toMs <= fromMs) return;

        const prev = state.flowResults[pairKey];
        if (prev && prev.fromTime === fromMs && prev.toTime === toMs) return; // đúng kết quả đang lưu -> không ghi lại

        // Điều kiện 10 cm: chưa đủ -> KHÔNG tính kết quả mới, giữ nguyên kết quả cũ
        if (!isFlowRecalcAllowed(prev, m.fromDistance)) return;

        const result = {
            fromTime: fromMs,
            toTime: toMs,
            targetRise: Number(m.targetRise.toFixed(3)),
            // Mốc so sánh cho lần tính tiếp theo = mực nước trạm nguồn tại lần tính này
            refDistance: Number(m.fromDistance.toFixed(3)),
            computedAt: Date.now(),
        };
        state.flowResults[pairKey] = result;
        set(ref(database, `WebSettings/FlowSpeedResults/${pairKey}`), result)
            .then(() => console.log(`[Tốc độ truyền lũ ${pairKey}] Đã lưu kết quả mới:`, result))
            .catch((error) => console.error(`Lỗi khi lưu kết quả tốc độ truyền lũ (${pairKey}):`, error));
    });
}

function parseStoredFlowResult(raw) {
    if (!raw) return null;
    const fromTime = Number(raw.fromTime);
    const toTime = Number(raw.toTime);
    const targetRise = Number(raw.targetRise);
    if (!Number.isFinite(fromTime) || !Number.isFinite(toTime) || !Number.isFinite(targetRise) || toTime <= fromTime) {
        return null;
    }
    const refDistance = Number(raw.refDistance);
    return {
        fromTime,
        toTime,
        targetRise,
        // Kết quả lưu từ bản cũ chưa có refDistance -> null: lần khớp kế tiếp được
        // tính bình thường, từ đó trở đi mới áp dụng điều kiện 10 cm.
        refDistance: Number.isFinite(refDistance) ? refDistance : null,
        computedAt: Number(raw.computedAt) || null,
    };
}

function renderFlowSpeedPanel() {
    const pairKey = state.activeFlowPair;
    const pair = FLOW_PAIRS[pairKey];
    const distanceKm = getPairDistanceKm(pairKey);

    const fromMeta = STATION_META[pair.from];
    const toMeta = STATION_META[pair.to];

    const resultEl = document.getElementById("flowResult");

    // Phần 1: trạng thái THEO DÕI HIỆN TẠI (như cũ - có thể đang "Đang chờ")
    const { fromConnected, toConnected, fromTime, toTime, targetRise, fromDistance } = computeCurrentFlowMatch(pairKey);

    const fromTimeText = fromTime ? formatClockDateTime(fromTime) : "Chưa có dữ liệu";
    const toTimeText = toTime ? formatClockDateTime(toTime) : "Chưa đạt mức tương ứng";

    let noteHtml = "";
    if (!fromConnected || !toConnected) {
        noteHtml = `<p class="flow-result-note">Cần cả hai trạm (${fromMeta.name}, ${toMeta.name}) có dữ liệu thật để ước tính tốc độ truyền lũ. Trạm chưa kết nối sẽ không có dữ liệu để phân tích.</p>`;
    } else if (!fromTime) {
        noteHtml = `<p class="flow-result-note">${fromMeta.name} chưa có dữ liệu mực nước nào - chưa có gì để theo dõi tốc độ truyền lũ.</p>`;
    } else if (!toTime) {
        noteHtml = `<p class="flow-result-note">${fromMeta.name} đang ở mức nước dâng <strong>${targetRise >= 0 ? "+" : ""}${targetRise.toFixed(
            2
        )} m</strong> so với mực nước tham chiếu riêng (ghi nhận lúc ${fromTimeText}), đang chờ ${toMeta.name} đạt mức tương ứng (sai số cho phép ±${(
            RISE_MATCH_TOLERANCE_M * 100
        ).toFixed(0)} cm) so với mốc tham chiếu riêng của ${toMeta.name} để xác định thời gian truyền lũ.</p>`;
    }

    // Phần 2: KẾT QUẢ GẦN NHẤT ĐÃ LƯU - luôn hiển thị nếu đã từng có, kể cả
    // khi phần theo dõi hiện tại đang "Đang chờ". Tốc độ tính lại theo
    // khoảng cách HIỆN TẠI (nếu người dùng vừa sửa khoảng cách).
    let metricsHtml = "";
    const saved = state.flowResults[pairKey];
    if (saved) {
        const timeDiffMs = saved.toTime - saved.fromTime;
        const timeDiffHours = timeDiffMs / 3600000;
        const speedKmh = timeDiffHours > 0 ? distanceKm / timeDiffHours : null;
        const savedRiseText = `${saved.targetRise >= 0 ? "+" : ""}${saved.targetRise.toFixed(2)} m`;

        // Trạng thái điều kiện 10 cm (chỉ để người xem biết vì sao tốc độ chưa đổi)
        let recalcNoteHtml = "";
        if (Number.isFinite(saved.refDistance) && Number.isFinite(fromDistance)) {
            const changeMm = levelChangeMm(fromDistance, saved.refDistance);
            const enough = changeMm >= Math.round(FLOW_RECALC_MIN_CHANGE_M * 1000);
            recalcNoteHtml = `<p class="flow-result-note">Mực nước ${fromMeta.name} đã thay đổi <strong>${(changeMm / 10).toFixed(
                1
            )} cm</strong> so với mốc ${saved.refDistance.toFixed(2)} m của lần tính gần nhất - ${
                enough
                    ? `đủ ${(FLOW_RECALC_MIN_CHANGE_M * 100).toFixed(0)} cm, tốc độ sẽ được tính lại khi ${toMeta.name} đạt mức tương ứng.`
                    : `chưa đủ ${(FLOW_RECALC_MIN_CHANGE_M * 100).toFixed(0)} cm nên giữ nguyên tốc độ đã tính.`
            }</p>`;
        }

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
            <p class="flow-result-note">
                Kết quả gần nhất: ${fromMeta.name} ở mức dâng <strong>${savedRiseText}</strong> lúc ${formatClockDateTime(new Date(saved.fromTime))}
                → ${toMeta.name} đạt mức tương ứng lúc ${formatClockDateTime(new Date(saved.toTime))}.
                Kết quả được giữ nguyên cho đến khi có kết quả mới.
            </p>
            ${recalcNoteHtml}
        `;
    } else if (fromConnected && toConnected && fromTime) {
        metricsHtml = `<p class="flow-result-note">Chưa có kết quả tốc độ truyền lũ nào được ghi nhận cho cặp trạm này.</p>`;
    }

    const targetRiseText = targetRise != null ? `${targetRise >= 0 ? "+" : ""}${targetRise.toFixed(2)} m` : "--";
    const fromBadge = fromTime
        ? `<span class="flow-result-badge is-done">✔ Mức hiện tại ${targetRiseText}</span>`
        : `<span class="flow-result-badge">⏳ Chưa có dữ liệu</span>`;
    const toBadge = toTime
        ? `<span class="flow-result-badge is-done">✔ Đạt mức tương ứng ${targetRiseText}</span>`
        : `<span class="flow-result-badge">⏳ Đang chờ</span>`;

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
        ${noteHtml}
        ${metricsHtml}
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

// GHI CHÚ: đã bỏ hẳn ô nhập "Mức nước dâng để phân tích" (riseThresholdInput)
// và listener của nó - không còn ngưỡng cố định do người dùng chọn nữa,
// xem renderFlowSpeedPanel()/findMatchingRiseAfter() ở trên.

// Đồng bộ 2 ô input khoảng cách với state.distances - dùng chung cho MỌI
// nơi state.distances thay đổi (mở form, tải trang xong, hoặc nhận dữ
// liệu mới từ Firebase qua onValue/get), không chỉ lúc bấm nút mở form.
//
// QUAN TRỌNG (đã sửa lỗi "Lưu khoảng cách xong, F5 lại thấy về mặc định
// 5.0/7.0" - lần debug trước đã XÁC NHẬN state.distances/Firebase vẫn lưu
// ĐÚNG giá trị mới sau F5, chỉ riêng 2 ô input này không tự cập nhật):
// TRƯỚC ĐÂY, distanceInput12/distanceInput23 CHỈ được gán giá trị bên
// trong listener "click" của editDistancesBtn (tức là CHỈ khi người dùng
// bấm mở form). Trong HTML, 2 ô input này có sẵn value="5.0"/"7.0" hard-
// code. Nếu form đang ở trạng thái "đang mở" ngay sau khi tải trang
// (hidden=false do trình duyệt/Live Server giữ lại DOM state, hoặc do
// người dùng để mở từ trước khi F5), 2 ô input vẫn hiển thị nguyên giá
// trị HTML gốc 5.0/7.0 - KHÔNG liên quan gì đến việc lưu có thành công
// hay không, chỉ là chưa có gì gọi hàm gán lại value cho chúng lúc trang
// vừa tải xong. Sửa: gọi hàm này ngay sau khi state.distances được xác
// định (thành công) trong onValue(distancesRef)/get(distancesRef), để 2
// ô input luôn khớp với dữ liệu thật, bất kể form đang mở hay đóng.
function syncDistanceInputs() {
    distanceInput12.value = state.distances["1-2"].toFixed(1);
    distanceInput23.value = state.distances["2-3"].toFixed(1);
}

editDistancesBtn.addEventListener("click", () => {
    const isHidden = distanceEditor.hidden;
    distanceEditor.hidden = !isHidden;
    if (isHidden) {
        syncDistanceInputs();
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
    // QUAN TRỌNG (đã sửa lỗi "xoá FloodSystem xong, thao tác gì đó lại bị
    // tạo lại"): TRƯỚC ĐÂY hàm này gọi thẳng update(floodRef, {WarningLevel:
    // ...}) - vì update() sẽ TỰ TẠO node Stations/<id>/FloodSystem nếu nó
    // chưa tồn tại. Hàm này chỉ được gọi khi isStationConnected(stationId)
    // là true ở 2 nơi gọi nó (SET "Mực nước tham chiếu" / "Cảnh báo mức 3"),
    // nhưng isStationConnected() đọc từ s.hasReceivedData - một cờ CỐ Ý
    // không bao giờ tự reset về false trong cùng 1 phiên trình duyệt (xem
    // comment ở onValue(flood, ...) - để không đột ngột khoá lại input nếu
    // trạm chỉ mất dữ liệu tạm thời). Hậu quả: nếu bạn xoá FloodSystem của
    // 1 trạm rồi bấm SET ở đúng panel trạm đó (mà KHÔNG tải lại trang giữa
    // 2 thao tác), cờ trong bộ nhớ vẫn coi là "đã kết nối" từ lần dữ liệu
    // gần nhất, hàm này vẫn chạy và TỰ TẠO LẠI node FloodSystem (chỉ với
    // field WarningLevel) - đúng như "tự động được tạo lại" mà không có
    // ESP32 nào ghi gì cả.
    // Sửa: không tin cờ trong bộ nhớ, luôn hỏi lại Firebase XEM NODE NÀY
    // THỰC SỰ ĐANG CÓ DỮ LIỆU THẬT (WaterLevel) HAY KHÔNG ngay trước khi
    // ghi - nếu node đã bị xoá/chưa từng tồn tại, bỏ qua, không ghi gì.
    get(floodRef)
        .then((snapshot) => {
            const current = snapshot.val();
            if (!current || !Number.isFinite(Number(current.WaterLevel))) {
                console.warn(
                    `[${stationId}] Bỏ qua đồng bộ ngưỡng phần cứng: trạm này chưa có dữ liệu FloodSystem ` +
                        `thật (chưa có ESP32 gửi WaterLevel) - không tự tạo lại node.`
                );
                return;
            }
            update(floodRef, { WarningLevel: distanceThreshold })
                .then(() =>
                    console.log(`[${stationId}] Đã đồng bộ ngưỡng phần cứng FloodSystem/WarningLevel:`, distanceThreshold)
                )
                .catch((error) => console.error(`[${stationId}] Lỗi khi đồng bộ ngưỡng phần cứng:`, error));
        })
        .catch((error) => console.error(`[${stationId}] Lỗi khi kiểm tra FloodSystem trước khi đồng bộ ngưỡng:`, error));
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

onValue(serverTimeOffsetRef, (snapshot) => {
    const offset = Number(snapshot.val());
    serverTimeOffsetMs = Number.isFinite(offset) ? offset : 0;
    renderHeaderStatus();
});

onValue(distancesRef, (snapshot) => {
    const data = snapshot.val();
    if (!data) {
        // QUAN TRỌNG (đã sửa lỗi "Lưu khoảng cách xong, F5 lại trang thì
        // mất, quay về mặc định 5.0/7.0"): TRƯỚC ĐÂY, cứ mỗi khi callback
        // này nhận snapshot rỗng (data=null) VÀ state.distancesInitialized
        // (biến JS, luôn bị reset về false mỗi khi tải lại trang) còn là
        // false, code lập tức GHI ĐÈ (set) WebSettings/StationDistances về
        // giá trị mặc định. Nhưng "data=null" ở lần callback ĐẦU TIÊN sau
        // khi F5 không có nghĩa là node chưa từng tồn tại - có thể chỉ là
        // độ trễ mạng bình thường trước khi Firebase kịp trả dữ liệu thật
        // về. Vì state.distancesInitialized luôn là false ngay sau F5, hệ
        // thống hiểu nhầm là "chưa từng lưu" và ghi đè mất giá trị người
        // dùng vừa lưu trước đó - đúng nguyên nhân của lỗi "lưu được nhưng
        // F5 lại mất".
        //
        // Sửa: giống hệt cách đã sửa cho WebSettings/<stationId> - gọi
        // get() một lần để XÁC NHẬN CHẮC CHẮN node thực sự trống trước khi
        // ghi đè mặc định, thay vì tin ngay giá trị null đầu tiên nhận
        // được từ onValue.
        if (!state.distancesInitialized) {
            get(distancesRef).then((freshSnapshot) => {
                if (state.distancesInitialized) return; // đã có lần khác (onValue thật) lo việc này rồi
                const freshData = freshSnapshot.val();
                if (freshData) {
                    // Node thực ra đã có dữ liệu (null trước đó chỉ là
                    // tạm thời/timing) - KHÔNG ghi đè, mà phải tự cập nhật
                    // state + render ngay tại đây, vì onValue sẽ KHÔNG bắn
                    // lại lần nữa nếu không có thay đổi nào khác xảy ra
                    // sau đó (nếu bỏ qua như trước, state.distances mãi
                    // giữ giá trị mặc định trong bộ nhớ dù Firebase đã có
                    // đúng giá trị người dùng lưu - đây là lý do bản vá
                    // trước vẫn bị "lưu được nhưng F5 vẫn hiện mặc định").
                    state.distancesInitialized = true;
                    const d12 = Number(freshData["1-2"]);
                    const d23 = Number(freshData["2-3"]);
                    state.distances = {
                        "1-2": Number.isFinite(d12) ? d12 : DEFAULT_DISTANCES["1-2"],
                        "2-3": Number.isFinite(d23) ? d23 : DEFAULT_DISTANCES["2-3"],
                    };
                    syncDistanceInputs();
                    renderHomeIfActive();
                    return;
                }
                // Xác nhận chắc chắn node thực sự trống -> mới khởi tạo mặc định.
                state.distancesInitialized = true;
                set(distancesRef, { ...DEFAULT_DISTANCES }).catch((error) =>
                    console.error("Lỗi khi khởi tạo khoảng cách mặc định giữa các trạm:", error)
                );
            });
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
    syncDistanceInputs();
    renderHomeIfActive();
});

// Đồng bộ "kết quả tốc độ truyền lũ gần nhất" từ Firebase - để kết quả
// vẫn còn sau khi F5 / mở trên máy khác.
onValue(flowResultsRef, (snapshot) => {
    const data = snapshot.val() || {};
    Object.keys(FLOW_PAIRS).forEach((pairKey) => {
        const stored = parseStoredFlowResult(data[pairKey]);
        if (stored) state.flowResults[pairKey] = stored;
    });
    if (state.currentViewId === "home") renderFlowSpeedPanel();
});

STATION_IDS.forEach((stationId) => {
    // QUAN TRỌNG (đã sửa): TRƯỚC ĐÂY có điều kiện "if (!isStationConnected)
    // return" ở đây khiến Trạm 2/3 KHÔNG BAO GIỜ được đăng ký lắng nghe
    // Firebase (vì lúc đó isStationConnected() luôn đọc từ hasHardware
    // hard-code = false) - dù ESP32 thật đã nạp code và gửi dữ liệu lên
    // đúng nhánh, web vẫn không hề gọi onValue nên không thể nhận được.
    // Giờ TẤT CẢ các trạm trong STATION_IDS đều được đăng ký lắng nghe như
    // nhau; trạng thái "đã kết nối" tự cập nhật ngay khi có dữ liệu thật
    // (xem s.hasReceivedData bên dưới), không cần biết trước trạm nào có
    // phần cứng.
    const { flood, measurement, configuration, webSettings, measureInterval } = stationRefs(stationId);

    // Đồng bộ chu kỳ đo (phút) từ Firebase về giao diện. Node chưa tồn tại
    // (null) => dùng mặc định, KHÔNG tự ghi gì lên Firebase (tránh tạo node
    // Configuration cho trạm chưa có phần cứng).
    onValue(measureInterval, (snapshot) => {
        const s = state.stations[stationId];
        const val = Number(snapshot.val());
        const newMin =
            Number.isFinite(val) && val >= MIN_MEASURE_INTERVAL_MIN && val <= MAX_MEASURE_INTERVAL_MIN
                ? Math.round(val)
                : DEFAULT_MEASURE_INTERVAL_MIN;
        // Chu kỳ bị ĐỔI trong lúc trang đang mở (không tính lần tải đầu):
        // giữ ngưỡng "mất kết nối" theo chu kỳ cũ thêm 1 chu kỳ cũ + 60s để
        // ESP32 kịp nhận giá trị mới (xem staleMsFor).
        if (s.measureIntervalLoaded && newMin !== s.measureIntervalMin) {
            s.prevMeasureIntervalMin = s.measureIntervalMin;
            s.intervalGraceUntil = Date.now() + s.measureIntervalMin * 60 * 1000 + 60 * 1000;
        }
        s.measureIntervalLoaded = true;
        s.measureIntervalMin = newMin;
        renderMeasureIntervalControls(stationId);
        if (state.currentViewId === stationId) renderChartForStation(stationId);
        renderHomeIfActive();
    });

    onValue(flood, (snapshot) => {
        const data = snapshot.val();
        const s = state.stations[stationId];

        if (!data) {
            // Chưa từng có dữ liệu (hoặc node đã bị xoá) - giữ nguyên trạng
            // thái "chưa kết nối" nếu chưa từng nhận được gì; nếu trạm đã
            // từng kết nối rồi mất node thì vẫn coi là đã kết nối (để không
            // đột ngột khoá lại input), chỉ mất "tươi" (fresh) theo staleMsFor().
            s.distance = null;
            s.outOfRange = false;
            s.lastUpdateRaw = null;
            if (state.currentViewId === stationId) renderStation(stationId);
            renderHeaderStatus();
            renderHomeIfActive();
            return;
        }

        // Lần đầu tiên trạm này có dữ liệu thật từ Firebase -> đánh dấu đã
        // kết nối. Vì trạng thái connected/chưa-connected quyết định CẢ
        // NHÁNH RENDER khác nhau (mở khoá input, hiển thị biểu đồ...), cần
        // render lại toàn bộ (không chỉ phần dữ liệu) ngay khi cờ này vừa
        // bật lên true.
        const justConnected = !s.hasReceivedData;
        s.hasReceivedData = true;

        // ---- XÁC ĐỊNH "THIẾT BỊ VỪA GỬI MỚI" (sửa lỗi Online/Offline sai) ----
        // TRƯỚC ĐÂY: mọi lần onValue(flood) chạy đều đặt lastReceivedAt =
        // Date.now(), kể cả khi (a) vừa mở trang và Firebase trả về dữ liệu CŨ
        // (thiết bị đã chết vẫn hiện "online"), hoặc (b) chính Web vừa ghi
        // FloodSystem/WarningLevel (không phải thiết bị gửi). Ngược lại, nếu
        // thiết bị gửi payload giống hệt lần trước (LastUpdate="N/A" + mực
        // nước không đổi) thì Firebase KHÔNG phát sự kiện -> Web tưởng mất kết nối.
        // SỬA: firmware mới gửi kèm UpdatedAt (giờ máy chủ) + Seq (luôn tăng);
        // tuổi dữ liệu tính theo UpdatedAt (xem stationDataAgeMs). Chỉ coi là
        // "lần gửi mới" khi dấu Seq/LastUpdate/UpdatedAt thay đổi.
        const updatedAt = Number(data.UpdatedAt);
        s.deviceUpdatedAt = Number.isFinite(updatedAt) ? updatedAt : null;
        const stamp = `${data.Seq ?? ""}|${data.LastUpdate ?? ""}|${data.UpdatedAt ?? ""}`;
        const isNewDevicePublish = stamp !== s.deviceStamp;
        s.deviceStamp = stamp;
        if (isNewDevicePublish && !justConnected) {
            // Chỉ dùng cho firmware cũ (không có UpdatedAt). Lần đầu mở trang
            // KHÔNG đặt - không biết dữ liệu đó cũ bao lâu rồi.
            s.lastReceivedAt = Date.now();
        }

        const distance = Number(data.WaterLevel);
        const outOfRange = isOutOfRange(distance);
        // "changed" chỉ dùng để quyết định có cần RENDER lại giao diện hay
        // không (mở khoá input, cập nhật số hiển thị...). KHÔNG được dùng
        // để quyết định "có phải điểm đo mới hay không" - vì justConnected
        // luôn = true ở lần onValue() đầu tiên MỖI KHI TẢI LẠI TRANG (F5),
        // kể cả khi Firebase không hề có bản ghi nào mới so với lần trước.
        const changed = justConnected || s.distance === null || distance !== s.distance || outOfRange !== s.outOfRange;

        s.distance = distance;
        s.outOfRange = outOfRange;
        s.lastUpdateRaw = data.LastUpdate || null;

        if (!outOfRange) {
            // QUAN TRỌNG (đã sửa lỗi "F5 tự thêm mốc thời gian mới trên
            // biểu đồ" + "F5 tự gửi thêm dữ liệu lên Google Sheets dù không
            // có gì mới"): TRƯỚC ĐÂY, code dùng "changed" (luôn true ở lần
            // đầu mỗi khi F5, xem giải thích ở trên) làm điều kiện duy nhất
            // để coi đây là "điểm đo mới" rồi tự động thêm vào lịch sử biểu
            // đồ + gửi sang Google Sheets. Hậu quả:
            //   1. Mỗi lần F5, dù ESP32 không gửi gì thêm, code vẫn coi lần
            //      đọc FloodSystem đầu tiên là "mới" và thêm 1 điểm vào biểu
            //      đồ - nếu đúng lúc đó parseVNDateTimeToDate(LastUpdate)
            //      không đọc được (dữ liệu cũ/định dạng lạ), code còn rơi
            //      vào nhánh dự phòng "|| new Date()" - LẤY LUÔN THỜI ĐIỂM
            //      BẤM F5 làm mốc thời gian đo - khiến biểu đồ hiện sai mốc
            //      (mốc "ảo" là giờ mở trang, không phải giờ đo thật).
            //   2. Vì mốc thời gian "ảo" đó khác mọi mốc đã có trong Google
            //      Sheets, cơ chế chống trùng ở Apps Script (so khoá theo
            //      Trạm + Thời gian đo) KHÔNG nhận ra được, nên vẫn ghi
            //      thành một dòng MỚI THẬT trên Sheet dù không có phép đo
            //      nào mới - đúng nguyên nhân lỗi "F5 là Sheet lại có thêm
            //      dữ liệu".
            //
            // Sửa: bỏ hẳn nhánh dự phòng "|| new Date()" (không còn dùng giờ
            // mở trang làm mốc đo giả), và chỉ coi là điểm đo MỚI THẬT SỰ
            // khi (a) ESP32 có gửi kèm LastUpdate hợp lệ, VÀ (b) mốc thời
            // gian đó CHƯA từng có trong lịch sử hiện tại của trạm (so theo
            // mili-giây) - vì get(measurement) bên dưới có thể đã nạp sẵn
            // đúng bản ghi này rồi, hoặc chính onValue() này đã từng thêm nó
            // ở lần chạy trước trong cùng phiên.
            const measuredAt = parseVNDateTimeToDate(s.lastUpdateRaw);
            if (measuredAt && !isPlausibleMeasurementTime(measuredAt)) {
                console.warn(
                    `[${stationId}] Bỏ qua điểm đo có mốc thời gian ở tương lai so với đồng hồ hiện tại ` +
                        `(LastUpdate="${s.lastUpdateRaw}") - khả năng cao đồng hồ ESP32 (RTC/NTP) chưa đồng bộ đúng.`
                );
            } else if (measuredAt) {
                const measuredAtMs = measuredAt.getTime();
                const alreadyRecorded = s.history.some((p) => p.t.getTime() === measuredAtMs);
                if (!alreadyRecorded) {
                    const newPoint = { t: measuredAt, distance, rise: computeRise(distance, s.initialLevel) };
                    s.history.push(newPoint);
                    s.history.sort((a, b) => a.t.getTime() - b.t.getTime());
                    if (s.history.length > CLIENT_HISTORY_LIMIT) s.history.shift();

                    // Sao lưu điểm đo MỚI THẬT SỰ sang Google Sheets (nếu đã
                    // cấu hình URL) - chỉ chạy khi web đang mở, không chặn
                    // luồng chính nếu lỗi mạng.
                    sendToGoogleSheetsBackup(stationId, newPoint);
                }
            }
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
            // QUAN TRỌNG (đã sửa lỗi "SET xong bị trả về giá trị mặc định"):
            // TRƯỚC ĐÂY, mỗi khi callback này nhận data=null (kể cả null
            // "tạm thời" do độ trễ mạng ngay sau khi update() vừa ghi lên
            // Firebase, hoặc do việc kết nối lại/onValue bắn lại), code sẽ
            // GHI ĐÈ (set) toàn bộ WebSettings/<stationId> về giá trị mặc
            // định NẾU s.webSettingsInitialized còn là false. Nhưng
            // s.webSettingsInitialized là biến JS trong bộ nhớ trình duyệt -
            // nó bị reset về false mỗi khi tải lại trang, kể cả khi node
            // Firebase THỰC RA đã có dữ liệu người dùng từng SET trước đó.
            // Nếu đúng lúc trang vừa tải/kết nối lại, callback đầu tiên vô
            // tình nhận được snapshot rỗng (do timing), hệ thống sẽ tưởng
            // "chưa từng khởi tạo" và ghi đè mặc định lên, xoá mất giá trị
            // người dùng đã lưu - đúng là nguyên nhân khiến SET "không ăn".
            //
            // Sửa: chỉ coi là "cần khởi tạo mặc định" khi ĐÃ CHẮC CHẮN node
            // này chưa từng tồn tại - kiểm tra lại bằng get() một lần thay
            // vì tin ngay vào giá trị null đầu tiên nhận được từ onValue.
            if (!s.webSettingsInitialized) {
                get(webSettings).then((freshSnapshot) => {
                    if (s.webSettingsInitialized) return; // đã có lần khác (onValue thật) lo việc này rồi
                    const freshData = freshSnapshot.val();
                    if (freshData) {
                        // Node thực ra đã có dữ liệu (null trước đó chỉ là
                        // tạm thời/timing) - KHÔNG ghi đè, mà phải tự cập
                        // nhật state + render ngay tại đây, vì onValue sẽ
                        // KHÔNG bắn lại lần nữa nếu không có thay đổi nào
                        // khác xảy ra sau đó (nếu chỉ set cờ rồi bỏ qua,
                        // state.stations[id].alertLevels/initialLevel mãi
                        // giữ giá trị mặc định trong bộ nhớ dù Firebase đã
                        // có đúng giá trị người dùng SET - đây là lý do
                        // bản vá trước vẫn bị "SET được nhưng F5 lại về
                        // mặc định").
                        s.webSettingsInitialized = true;
                        const initialLevel = Number(freshData.InitialLevel);
                        s.initialLevel = Number.isFinite(initialLevel) ? initialLevel : DEFAULT_INITIAL_LEVEL;
                        const lv = freshData.AlertLevels || {};
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
                        return;
                    }
                    // Xác nhận chắc chắn node thực sự trống -> mới khởi tạo mặc định.
                    s.webSettingsInitialized = true;
                    pushDefaultWebSettings(stationId, webSettings);
                });
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

            // Bỏ qua hẳn bản ghi nào không đọc được Timestamp hợp lệ, thay vì
            // dùng "new Date()" (giờ tải trang) làm mốc thay thế như trước -
            // cùng nguyên tắc đã áp dụng ở onValue(flood, ...): không bao giờ
            // tự bịa mốc thời gian, vì mỗi lần F5 hàm get() này đều chạy lại
            // - nếu vẫn còn fallback "new Date()" thì mỗi lần tải trang có
            // thể sinh ra một mốc "ảo" khác nhau cho cùng 1 bản ghi lỗi định
            // dạng, gây đúng lỗi "F5 tự đổi mốc thời gian" ở quy mô nhỏ hơn.
            // Đồng thời loại bỏ bản ghi có Timestamp hợp lệ về mặt định dạng
            // nhưng lại rơi vào TƯƠNG LAI so với đồng hồ hiện tại (đồng hồ
            // ESP32 sai/dữ liệu cũ có ngày tháng sai) - xem giải thích chi
            // tiết ở isPlausibleMeasurementTime() phía trên: chỉ 1 bản ghi như
            // vậy cũng đủ kéo giãn sai toàn bộ trục thời gian của biểu đồ.
            const points = rawPoints
                .filter((p) => p.parsedT !== null && isPlausibleMeasurementTime(p.parsedT))
                .map((p) => ({
                    t: p.parsedT,
                    distance: p.distance,
                    rise: computeRise(p.distance, s.initialLevel),
                }));

            // Chỉ thêm những điểm CHƯA có sẵn trong s.history (so theo mốc
            // thời gian, mili-giây) - tránh bị trùng với điểm mà
            // onValue(flood, ...) có thể đã thêm trước đó do thứ tự chạy
            // giữa 2 lệnh gọi Firebase này khi tải trang không cố định (get()
            // là bất đồng bộ, có thể xong trước hoặc sau onValue() lần đầu).
            const existingTimes = new Set(s.history.map((p) => p.t.getTime()));
            const newPoints = points.filter((p) => !existingTimes.has(p.t.getTime()));
            s.history.unshift(...newPoints);
            s.history.sort((a, b) => a.t.getTime() - b.t.getTime());
            if (state.currentViewId === stationId) renderChartForStation(stationId);
            renderHomeIfActive();

            // "Bù dữ liệu" sang Google Sheets: dùng LẠI đúng dữ liệu vừa
            // tải ở trên, chỉ lọc chặt hơn (bỏ luôn bản ghi không có
            // Timestamp hợp lệ - KHÔNG dùng thời gian fallback như trên,
            // vì gửi sai thời điểm đo sẽ làm sai khoá chống trùng ở Apps
            // Script và làm sai dữ liệu lưu trữ dài hạn).
            const backfillPoints = rawPoints
                .filter((p) => p.parsedT !== null && isPlausibleMeasurementTime(p.parsedT))
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
}, 1000);

// ------------------------------------------------------------
// KHỞI ĐỘNG
// ------------------------------------------------------------
console.log("Firebase đã kết nối thành công! (script.js - Giai đoạn 4: Đa trạm + Trang chủ)");
STATION_IDS.forEach((stationId) => renderStation(stationId));
renderHeaderStatus();
renderHome();
