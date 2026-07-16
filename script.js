// ==========================
// Firebase SDK
// ==========================

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";

import {
    getDatabase,
    ref,
    onValue,
    update,
    push,
    get,
    remove
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js";


// ==========================
// Firebase Config
// ==========================

const firebaseConfig = {
    apiKey: "AIzaSyCy37cWboOIIxPN0_LvnZiefjDq1Z5coEw",
    authDomain: "flood-iot-9bd06.firebaseapp.com",
    databaseURL: "https://flood-iot-9bd06-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "flood-iot-9bd06",
    storageBucket: "flood-iot-9bd06.firebasestorage.app",
    messagingSenderId: "999141864715",
    appId: "1:999141864715:web:0baa1905357397afd55e0e",
    measurementId: "G-BG54YREV5D"
};


// ==========================
// Khởi tạo Firebase
// ==========================

const app = initializeApp(firebaseConfig);
const database = getDatabase(app);

// NOTE: Website hiện được phép DỌN DẸP (xóa) các bản ghi Measurement cũ
// để tránh phình dữ liệu và tốn tài nguyên. Chỉ giữ lại MAX_MEASUREMENTS
// bản ghi gần nhất. Việc ghi Measurement mới vẫn do thiết bị ESP32 đảm nhiệm;
// website chỉ đọc và dọn dẹp phần dư thừa.

const MAX_MEASUREMENTS = 5; // Số bản ghi Measurement muốn giữ lại

// Keep an in-memory FIFO of the last 3 measurements for display only.
const recentMeasurements = [];


// ==========================
// Lấy các phần tử HTML
// ==========================

const waterLevel = document.getElementById("waterLevel");
const warningSlider = document.getElementById("warningSlider");
const warningValue = document.getElementById("warningValue");

const systemStatus = document.getElementById("systemStatus");
const statusDescription = document.getElementById("statusDescription");
const statusCard = document.getElementById("statusCard");

const lastUpdate = document.getElementById("lastUpdate");


// ==========================
// Đường dẫn Firebase
// ==========================

const floodRef = ref(database, "FloodSystem");
const measurementRef = ref(database, "Measurement");
const configurationRef = ref(database, "Configuration");

let lastWaterLevel = null;
let lastWarningLevel = null;

// ESP32 ghi giá trị -1 (sentinel) khi cảm biến không đo được (mất Echo
// hoặc vượt quá tầm đo tối đa ~4m). Web IoT dùng hàm này để nhận biết
// và hiển thị "Ngoài tầm đo" thay vì một con số gây hiểu nhầm.
function isOutOfRange(waterLevelValue) {
    return !Number.isFinite(waterLevelValue) || waterLevelValue < 0;
}

// Chặn nhiều lượt dọn dẹp chạy chồng lên nhau cùng lúc
let isCleaningUp = false;

// ==========================
// Chart.js
// ==========================

const ctx = document.getElementById("waterChart");

const labels = [];

const waterData = [];

const waterChart = new Chart(ctx, {

    type: "line",

    data: {

        labels: labels,

        datasets: [{

            label: "Mực nước (m)",

            data: waterData,

            borderColor: "#2196f3",

            backgroundColor: "rgba(33,150,243,0.15)",

            borderWidth: 3,

            tension: 0.35,

            fill: true,

            pointRadius: 4

        }]

    },

    options: {

        responsive: true,

        maintainAspectRatio: false,

        animation: true,

        scales: {

            y: {

                beginAtZero: false

            }

        }

    }

});


// ==========================
// Cập nhật trạng thái hệ thống
// ==========================

function updateSystemStatus(waterLevelValue, warningLevelValue) {

    let state = "normal";
    let label = "🟢 Bình thường";
    let description = "Mực nước dưới ngưỡng cảnh báo.";

    // Nếu cảm biến không đo được (ngoài tầm đo), vẫn xem là bình thường
    // theo yêu cầu hiện tại.
    if (isOutOfRange(waterLevelValue)) {

        state = "normal";
        label = "🟢 Bình thường";
        description = "Ngoài tầm đo. Mực nước hiện tại được xem là bình thường.";

        systemStatus.className = `status ${state}`;
        systemStatus.textContent = label;
        statusDescription.textContent = description;
        statusCard.className = `card status-card ${state}`;
        return;

    }

    const dangerThreshold = warningLevelValue + 0.20;
    const warningThreshold = warningLevelValue + 0.30;

    if (waterLevelValue <= dangerThreshold) {
        state = "danger";
        label = "🔴 Nguy hiểm";
        description = "Mực nước đang ở mức nguy hiểm. Cần hành động ngay.";
    }
    else if (waterLevelValue <= warningThreshold) {
        state = "warning";
        label = "🟠 Cảnh báo";
        description = "Mực nước chạm mức cảnh báo. Cần theo dõi.";
    }
    else {
        state = "normal";
        label = "🟢 Bình thường";
        description = "Mực nước đang ở mức an toàn. Không cần hành động.";
    }

    systemStatus.className = `status ${state}`;
    systemStatus.textContent = label;

    statusDescription.textContent = description;

    statusCard.className = `card status-card ${state}`;

}

function saveMeasurement(waterLevelValue) {

    const measurement = {
        WaterLevel: isOutOfRange(waterLevelValue) ? "out_of_range" : waterLevelValue,
        Timestamp: new Date().toISOString()
    };

    // Website chỉ giữ 3 bản ghi gần nhất trong bộ nhớ tạm để hiển thị UI.
    // Việc ghi Measurement thật sự lên Firebase vẫn do ESP32 thực hiện.
    recentMeasurements.push(measurement);
    if (recentMeasurements.length > 3) recentMeasurements.shift();
    console.log('Stored measurement locally (UI-only):', measurement);

}

function saveConfiguration(warningLevelValue) {

    const config = {
        WarningLevel: warningLevelValue,
        LastUpdated: new Date().toISOString()
    };

    update(configurationRef, config)
        .then(() => {
            console.log("Đã lưu configuration:", config);
        })
        .catch((error) => {
            console.error("Lỗi khi lưu configuration:", error);
        });

}

// Ghi WarningLevel dự phòng thẳng lên FloodSystem (node mà ESP32 và web
// dùng để so sánh trạng thái), dùng khi phát hiện Firebase chưa có giá
// trị hợp lệ. Tách riêng khỏi saveConfiguration() vì Configuration chỉ
// là log lịch sử, không phải nguồn dữ liệu ESP32 đọc về.
function saveWarningLevelToFloodSystem(warningLevelValue) {

    update(floodRef, {
        WarningLevel: warningLevelValue
    })
        .then(() => {
            console.log("Đã khởi tạo WarningLevel mặc định trên FloodSystem:", warningLevelValue);
        })
        .catch((error) => {
            console.error("Lỗi khi khởi tạo WarningLevel mặc định:", error);
        });

}

function addChartPoint(waterLevelValue) {

    const now = new Date();
    const time =
        now.getHours().toString().padStart(2, "0") + ":" +
        now.getMinutes().toString().padStart(2, "0") + ":" +
        now.getSeconds().toString().padStart(2, "0");

    labels.push(time);
    waterData.push(waterLevelValue);

    if (labels.length > 20) {
        labels.shift();
        waterData.shift();
    }

    waterChart.update();

}


// ==========================
// Dọn dẹp Measurement cũ
// ==========================
// Firebase push() key có tính chất tăng dần theo thời gian tạo, nên
// chỉ cần sort các key theo dạng chuỗi là được thứ tự thời gian đúng
// (không cần chỉ mục orderByChild("Timestamp"), tránh phải cấu hình
// index trên Firebase Rules).

async function cleanupOldMeasurements() {

    if (isCleaningUp) return; // tránh chạy chồng lấn
    isCleaningUp = true;

    try {

        const snapshot = await get(measurementRef);
        const data = snapshot.val();

        if (!data) {
            isCleaningUp = false;
            return;
        }

        const keys = Object.keys(data).sort(); // cũ -> mới

        if (keys.length > MAX_MEASUREMENTS) {

            const keysToDelete = keys.slice(0, keys.length - MAX_MEASUREMENTS);

            // Dùng update() với giá trị null cho từng key để xóa nhiều
            // bản ghi cùng lúc trong 1 lần ghi duy nhất (hiệu quả hơn
            // gọi remove() lặp lại nhiều lần).
            const updates = {};
            keysToDelete.forEach((key) => {
                updates[key] = null;
            });

            await update(measurementRef, updates);

            console.log(
                `Đã xóa ${keysToDelete.length} bản ghi Measurement cũ, ` +
                `giữ lại ${MAX_MEASUREMENTS} bản ghi mới nhất.`
            );

        }

    } catch (error) {

        console.error("Lỗi khi dọn dẹp Measurement:", error);

    } finally {

        isCleaningUp = false;

    }

}


// ==========================
// Đọc dữ liệu Realtime
// ==========================

onValue(floodRef, (snapshot) => {

    const data = snapshot.val();

    if (!data) {

        waterLevel.textContent = "Không có dữ liệu";
        warningValue.textContent = "--";
        lastUpdate.textContent = "--:--:--";

        systemStatus.textContent = "🟢 Bình thường";
        statusDescription.textContent = "Chưa có dữ liệu từ cảm biến.";

        statusCard.className = "card status-card normal";

        return;

    }

    const waterLevelValue = Number(data.WaterLevel);
    let warningLevelValue = Number(data.WarningLevel);
    const outOfRange = isOutOfRange(waterLevelValue);

    // Nếu Firebase chưa có WarningLevel hợp lệ (node chưa từng được ghi,
    // ví dụ chưa ai kéo Slider lần nào), Number(undefined/null) sẽ ra NaN.
    // Nếu không xử lý, MỌI phép so sánh với NaN đều = false, khiến hệ
    // thống bị "kẹt" ở trạng thái Bình thường dù mực nước thực tế đã
    // vượt ngưỡng. Ở đây dùng giá trị hiện tại của Slider làm dự phòng,
    // đồng thời ghi giá trị đó lên Firebase để lần sau không bị lặp lại.
    if (!Number.isFinite(warningLevelValue) || warningLevelValue <= 0) {
        console.warn("WarningLevel không hợp lệ trên Firebase, dùng giá trị Slider hiện tại làm dự phòng.");
        warningLevelValue = Number(warningSlider.value);
        saveWarningLevelToFloodSystem(warningLevelValue);
    }

    // Hiển thị mực nước

    waterLevel.textContent = outOfRange
        ? "Ngoài tầm đo"
        : waterLevelValue.toFixed(2) + " m";

    // Hiển thị ngưỡng cảnh báo

    warningValue.textContent =
        warningLevelValue.toFixed(2) + " m";

    // Đồng bộ thanh Slider

    warningSlider.value = warningLevelValue;

    // Hiển thị thời gian cập nhật

    lastUpdate.textContent = data.LastUpdate || "--:--:--";

    // Cập nhật trạng thái

    updateSystemStatus(
        waterLevelValue,
        warningLevelValue
    );

    const waterChanged = lastWaterLevel === null || waterLevelValue !== lastWaterLevel;
    const warningChanged = lastWarningLevel === null || warningLevelValue !== lastWarningLevel;

    if (waterChanged) {
        saveMeasurement(waterLevelValue);

        // Chỉ vẽ lên biểu đồ khi giá trị hợp lệ. Giá trị "ngoài tầm đo"
        // (sentinel -1) không phải là mực nước thật nên bỏ qua, tránh
        // vẽ một điểm sai (ví dụ tụt xuống -1m) làm sai lệch biểu đồ.
        if (!outOfRange) {
            addChartPoint(waterLevelValue);
        }

        // Mỗi khi có dữ liệu mực nước mới (nghĩa là ESP32 vừa ghi thêm
        // một bản ghi Measurement), kiểm tra và dọn dẹp bớt bản ghi cũ.
        cleanupOldMeasurements();
    }

    if (warningChanged) {
        saveConfiguration(warningLevelValue);
    }

    lastWaterLevel = waterLevelValue;
    lastWarningLevel = warningLevelValue;

    // Debug

    console.log("========== FloodSystem ==========");
    console.log("Mực nước:", waterLevelValue);
    console.log("Ngưỡng:", warningLevelValue);
    console.log("Cập nhật:", data.LastUpdate);
    console.log("Water changed:", waterChanged);
    console.log("Warning changed:", warningChanged);
    console.log("===============================");

});


// ==========================
// Khi kéo Slider
// ==========================

warningSlider.addEventListener("input", () => {

    warningValue.textContent =
        Number(warningSlider.value).toFixed(2) + " m";

});


// ==========================
// Khi thả Slider
// ==========================

warningSlider.addEventListener("change", () => {

    update(floodRef, {

        WarningLevel: Number(warningSlider.value)

    })

    .then(() => {

        console.log("Đã cập nhật ngưỡng cảnh báo.");

    })

    .catch((error) => {

        console.error(error);

    });

});

// ==========================
// Khởi động
// ==========================

console.log("Firebase đã kết nối thành công!");

// Dọn dẹp một lần ngay khi trang vừa tải, phòng trường hợp dữ liệu
// cũ đã tích lũy từ trước khi có logic này.
cleanupOldMeasurements();
