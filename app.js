/* ========== 常量 ========== */

// V2 使用统一的数据包，便于完整备份和云端同步。
const STORAGE_KEY = "autumn_recruitment_tracker_v2";
const LEGACY_STORAGE_KEY = "autumn_recruitment_tracker_v1";
const CLOUD_CONFIG_KEY = "autumn_recruitment_tracker_cloud_config_v1";

const STATUS_OPTIONS = [
  { value: "preparing", label: "准备投递" },
  { value: "applied", label: "已投递" },
  { value: "test", label: "笔试" },
  { value: "interview", label: "面试中" },
  { value: "hr", label: "HR 面" },
  { value: "offer", label: "Offer" },
  { value: "rejected", label: "已拒" },
  { value: "silent", label: "无回应" },
  { value: "withdrawn", label: "主动放弃" }
];

const PRIORITY_OPTIONS = [
  { value: "high", label: "高优先级" },
  { value: "medium", label: "中优先级" },
  { value: "low", label: "低优先级" }
];

const QUESTION_CATEGORIES = [
  "Java / JVM",
  "数据库",
  "计算机网络",
  "操作系统",
  "算法",
  "系统设计",
  "项目经历",
  "行为面 / HR",
  "其他"
];

const STATUS_MAP = Object.fromEntries(STATUS_OPTIONS.map(item => [item.value, item.label]));
const PRIORITY_MAP = Object.fromEntries(PRIORITY_OPTIONS.map(item => [item.value, item.label]));

const DONUT_COLORS = {
  preparing: "#9ca3af",
  applied: "#4f83e8",
  test: "#8b5cf6",
  interview: "#d6a232",
  hr: "#e8793b",
  offer: "#35a463",
  rejected: "#df5b59",
  silent: "#6b7280",
  withdrawn: "#9a6546"
};

/* ========== 运行状态 ========== */

let data = loadData();
let activeApplicationId = null;
let calendarCursor = new Date();
calendarCursor.setDate(1);

let supabaseClient = null;
let currentUser = null;
let cloudPushTimer = null;
let cloudInitializing = false;

/* ========== DOM 快捷函数 ========== */

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

/* ========== 初始化 ========== */

init();

function init() {
  fillStaticSelects();
  bindEvents();
  renderAll();
  loadCloudConfigIntoForm();
  initializeCloudIfConfigured();
  checkDueNotifications();
}

/* ========== 数据模型与迁移 ========== */

function createEmptyData() {
  const now = new Date().toISOString();

  return {
    version: 2,
    meta: { createdAt: now, updatedAt: now },
    applications: [],
    reminders: [],
    questions: []
  };
}

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalizeData(JSON.parse(raw));

    // 自动兼容第一版 LocalStorage 数据。
    const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacyRaw) {
      const oldApplications = JSON.parse(legacyRaw);
      if (Array.isArray(oldApplications)) {
        const migrated = createEmptyData();
        migrated.applications = oldApplications.map(normalizeApplication);
        migrated.meta.updatedAt = new Date().toISOString();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
        return migrated;
      }
    }
  } catch (error) {
    console.error("读取本地数据失败：", error);
  }

  return createEmptyData();
}

function normalizeData(input) {
  const empty = createEmptyData();
  const source = input && typeof input === "object" ? input : {};

  return {
    version: 2,
    meta: {
      createdAt: source.meta?.createdAt || empty.meta.createdAt,
      updatedAt: source.meta?.updatedAt || empty.meta.updatedAt
    },
    applications: Array.isArray(source.applications)
      ? source.applications.map(normalizeApplication)
      : [],
    reminders: Array.isArray(source.reminders)
      ? source.reminders.map(normalizeReminder)
      : [],
    questions: Array.isArray(source.questions)
      ? source.questions.map(normalizeQuestion)
      : []
  };
}

function normalizeApplication(item = {}) {
  const now = new Date().toISOString();

  return {
    id: item.id || createId("app"),
    company: item.company || "",
    role: item.role || "",
    roleType: item.roleType || "",
    applyDate: item.applyDate || "",
    channel: item.channel || "",
    location: item.location || "",
    salary: item.salary || "",
    priority: PRIORITY_MAP[item.priority] ? item.priority : "medium",
    status: STATUS_MAP[item.status] ? item.status : "applied",
    expectedResult: item.expectedResult || "",
    jobUrl: item.jobUrl || "",
    note: item.note || "",
    createdAt: item.createdAt || now,
    updatedAt: item.updatedAt || now,
    stages: Array.isArray(item.stages)
      ? item.stages.map(stage => ({
          id: stage.id || createId("stage"),
          name: stage.name || "",
          date: stage.date || "",
          result: stage.result || "",
          format: stage.format || "",
          interviewer: stage.interviewer || "",
          duration: stage.duration || "",
          questions: stage.questions || "",
          reflection: stage.reflection || "",
          notes: stage.notes || "",
          createdAt: stage.createdAt || now,
          updatedAt: stage.updatedAt || now
        }))
      : []
  };
}

function normalizeReminder(item = {}) {
  const now = new Date().toISOString();

  return {
    id: item.id || createId("rem"),
    title: item.title || "",
    date: item.date || "",
    time: item.time || "",
    applicationId: item.applicationId || "",
    note: item.note || "",
    done: Boolean(item.done),
    createdAt: item.createdAt || now,
    updatedAt: item.updatedAt || now
  };
}

function normalizeQuestion(item = {}) {
  const now = new Date().toISOString();

  return {
    id: item.id || createId("q"),
    category: QUESTION_CATEGORIES.includes(item.category) ? item.category : "其他",
    difficulty: ["easy", "medium", "hard"].includes(item.difficulty) ? item.difficulty : "medium",
    companyApplicationId: item.companyApplicationId || "",
    stage: item.stage || "",
    text: item.text || "",
    answer: item.answer || "",
    reflection: item.reflection || "",
    tags: Array.isArray(item.tags) ? item.tags : [],
    createdAt: item.createdAt || now,
    updatedAt: item.updatedAt || now
  };
}

function saveData(options = {}) {
  data.meta.updatedAt = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

  if (!options.skipCloud) scheduleCloudPush();
}

/* ========== 通用工具 ========== */

function createId(prefix = "id") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function toDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function todayKey() {
  return toDateKey(new Date());
}

function sortByUpdatedAt(list) {
  return [...list].sort(
    (a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()
  );
}

function getApplicationById(id) {
  return data.applications.find(item => item.id === id);
}

function getApplicationLabel(id) {
  const item = getApplicationById(id);
  return item ? `${item.company} · ${item.role}` : "未关联投递";
}

function getInitial(company) {
  return company ? company.trim().slice(0, 1).toUpperCase() : "?";
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 1800);
}

function openModal(id) {
  document.getElementById(id).classList.add("show");
}

function closeModal(id) {
  document.getElementById(id).classList.remove("show");
}

function downloadFile(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

/* ========== 静态选项与事件 ========== */

function fillStaticSelects() {
  $("#status").innerHTML = STATUS_OPTIONS.map(item => `<option value="${item.value}">${item.label}</option>`).join("");
  $("#priority").innerHTML = PRIORITY_OPTIONS.map(item => `<option value="${item.value}">${item.label}</option>`).join("");
  $("#applicationStatusFilter").innerHTML = `<option value="">全部状态</option>` + STATUS_OPTIONS.map(item => `<option value="${item.value}">${item.label}</option>`).join("");
  $("#applicationPriorityFilter").innerHTML = `<option value="">全部优先级</option>` + PRIORITY_OPTIONS.map(item => `<option value="${item.value}">${item.label}</option>`).join("");
  $("#questionCategory").innerHTML = QUESTION_CATEGORIES.map(item => `<option>${escapeHtml(item)}</option>`).join("");
  $("#questionCategoryFilter").innerHTML = `<option value="">全部分类</option>` + QUESTION_CATEGORIES.map(item => `<option>${escapeHtml(item)}</option>`).join("");
}

function bindEvents() {
  $("#quickAddBtn").addEventListener("click", openAddApplicationModal);
  $("#addApplicationBtn").addEventListener("click", openAddApplicationModal);
  $("#cloudBtn").addEventListener("click", () => openModal("cloudModal"));
  $("#backupBtn").addEventListener("click", () => openModal("backupModal"));

  $("#tabs").addEventListener("click", event => {
    const button = event.target.closest("[data-view]");
    if (button) switchView(button.dataset.view);
  });

  $$("[data-close]").forEach(button => {
    button.addEventListener("click", () => closeModal(button.dataset.close));
  });

  $$(".modal-backdrop").forEach(backdrop => {
    backdrop.addEventListener("click", event => {
      if (event.target === backdrop) backdrop.classList.remove("show");
    });
  });

  $("#saveApplicationBtn").addEventListener("click", saveApplicationFromForm);
  $("#applicationSearch").addEventListener("input", renderApplications);
  $("#applicationStatusFilter").addEventListener("change", renderApplications);
  $("#applicationPriorityFilter").addEventListener("change", renderApplications);
  $("#applicationLocationFilter").addEventListener("change", renderApplications);

  $("#saveStageBtn").addEventListener("click", saveStageFromForm);

  $("#addReminderBtn").addEventListener("click", () => openAddReminderModal());
  $("#saveReminderBtn").addEventListener("click", saveReminderFromForm);
  $("#prevMonthBtn").addEventListener("click", () => moveCalendarMonth(-1));
  $("#nextMonthBtn").addEventListener("click", () => moveCalendarMonth(1));
  $("#todayBtn").addEventListener("click", () => {
    calendarCursor = new Date();
    calendarCursor.setDate(1);
    renderCalendar();
  });
  $("#notifyBtn").addEventListener("click", requestNotificationPermission);
  $("#exportIcsBtn").addEventListener("click", exportIcs);

  $("#addQuestionBtn").addEventListener("click", openAddQuestionModal);
  $("#saveQuestionBtn").addEventListener("click", saveQuestionFromForm);
  $("#questionSearch").addEventListener("input", renderQuestions);
  $("#questionCategoryFilter").addEventListener("change", renderQuestions);
  $("#questionCompanyFilter").addEventListener("change", renderQuestions);

  $("#closeDrawer").addEventListener("click", closeDrawer);
  $("#drawerBackdrop").addEventListener("click", event => {
    if (event.target === $("#drawerBackdrop")) closeDrawer();
  });

  $("#exportJsonBtn").addEventListener("click", exportJson);
  $("#exportCsvBtn").addEventListener("click", exportCsv);
  $("#importBtn").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", importJson);
  $("#clearAllBtn").addEventListener("click", clearAllLocalData);

  $("#saveCloudConfigBtn").addEventListener("click", saveCloudConfig);
  $("#signInBtn").addEventListener("click", signInCloud);
  $("#signUpBtn").addEventListener("click", signUpCloud);
  $("#signOutBtn").addEventListener("click", signOutCloud);
  $("#smartSyncBtn").addEventListener("click", smartSync);
  $("#pushCloudBtn").addEventListener("click", () => pushCloudData(true));
  $("#pullCloudBtn").addEventListener("click", () => pullCloudData(true));

  window.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      $$(".modal-backdrop.show").forEach(item => item.classList.remove("show"));
      $("#drawerBackdrop").classList.remove("show");
    }
  });
}

function switchView(view) {
  $$(".tab").forEach(tab => tab.classList.toggle("active", tab.dataset.view === view));
  $$(".view").forEach(section => section.classList.toggle("active", section.id === `view-${view}`));

  if (view === "dashboard") renderDashboard();
  if (view === "applications") renderApplications();
  if (view === "calendar") renderCalendar();
  if (view === "questions") renderQuestions();
}

/* ========== 总渲染与 Dashboard ========== */

function renderAll() {
  renderDashboard();
  renderApplicationFilters();
  renderApplications();
  renderReminderApplicationOptions();
  renderCalendar();
  renderQuestionFilters();
  renderQuestions();
  refreshDrawerIfOpen();
}

function renderDashboard() {
  renderDashboardStats();
  renderStatusDonut();
  renderFunnel();
  renderPriorityChart();
  renderChannelChart();
  renderTrendChart();
  renderDashboardUpcoming();
  renderTopicCloud();
}

function renderDashboardStats() {
  const total = data.applications.length;
  const active = data.applications.filter(item => ["test", "interview", "hr"].includes(item.status)).length;
  const offers = data.applications.filter(item => item.status === "offer").length;
  const highPriority = data.applications.filter(item => item.priority === "high").length;
  const pendingReminders = data.reminders.filter(item => !item.done).length;
  const offerRate = total ? ((offers / total) * 100).toFixed(1) : "0.0";

  const items = [
    ["总投递", total, "全部岗位记录"],
    ["进行中", active, "笔试 / 面试 / HR"],
    ["Offer", offers, "最终拿到 Offer"],
    ["高优先级", highPriority, "重点关注公司"],
    ["待办提醒", pendingReminders, "未完成事项"],
    ["Offer 率", `${offerRate}%`, "Offer / 总投递"]
  ];

  $("#dashboardStats").innerHTML = items.map(item => `
    <article class="panel stat-card">
      <div class="stat-label">${item[0]}</div>
      <div class="stat-value">${item[1]}</div>
      <div class="stat-sub">${item[2]}</div>
    </article>`).join("");
}

function renderStatusDonut() {
  const counts = STATUS_OPTIONS.map(option => ({
    ...option,
    count: data.applications.filter(item => item.status === option.value).length
  })).filter(item => item.count > 0);

  const total = data.applications.length;
  $("#donutTotal").textContent = total;

  if (!total) {
    $("#statusDonut").style.background = "#e9ecea";
    $("#statusLegend").innerHTML = `<div class="muted" style="font-size:11px;">暂无投递数据。</div>`;
    return;
  }

  let cursor = 0;
  const segments = counts.map(item => {
    const start = cursor;
    cursor += (item.count / total) * 100;
    return `${DONUT_COLORS[item.value]} ${start}% ${cursor}%`;
  });

  $("#statusDonut").style.background = `conic-gradient(${segments.join(",")})`;
  $("#statusLegend").innerHTML = counts.map(item => `
    <div class="legend-item">
      <div class="legend-name"><span class="legend-dot" style="background:${DONUT_COLORS[item.value]}"></span><span>${escapeHtml(item.label)}</span></div>
      <strong>${item.count}</strong>
    </div>`).join("");
}

function renderFunnel() {
  const total = data.applications.length || 1;
  const rows = [
    ["已投递", data.applications.filter(item => item.status !== "preparing").length],
    ["进入笔试", data.applications.filter(item => ["test", "interview", "hr", "offer"].includes(item.status)).length],
    ["进入面试", data.applications.filter(item => ["interview", "hr", "offer"].includes(item.status)).length],
    ["进入 HR", data.applications.filter(item => ["hr", "offer"].includes(item.status)).length],
    ["Offer", data.applications.filter(item => item.status === "offer").length]
  ];

  $("#funnelList").innerHTML = rows.map(([label, count]) => {
    const percent = data.applications.length ? Math.round((count / total) * 100) : 0;
    return `<div class="progress-row"><div class="progress-head"><span>${label}</span><span class="muted">${count} · ${percent}%</span></div><div class="progress-track"><div class="progress-bar" style="width:${Math.min(percent, 100)}%"></div></div></div>`;
  }).join("");
}

function renderPriorityChart() {
  const rows = PRIORITY_OPTIONS.map(option => ({
    label: option.label,
    count: data.applications.filter(item => item.priority === option.value).length
  }));
  const max = Math.max(...rows.map(item => item.count), 1);

  $("#priorityChart").innerHTML = rows.map(item => `
    <div class="bar-row"><span>${item.label}</span><div class="bar-track"><div class="bar-fill" style="width:${(item.count / max) * 100}%"></div></div><strong>${item.count}</strong></div>`).join("");
}

function renderChannelChart() {
  const map = new Map();

  data.applications.forEach(item => {
    const channel = item.channel || "未填写";
    const value = map.get(channel) || { total: 0, offers: 0 };
    value.total += 1;
    if (item.status === "offer") value.offers += 1;
    map.set(channel, value);
  });

  const rows = [...map.entries()].map(([channel, value]) => ({
    channel,
    ...value,
    rate: value.total ? Math.round((value.offers / value.total) * 100) : 0
  })).sort((a, b) => b.total - a.total).slice(0, 6);

  if (!rows.length) {
    $("#channelChart").innerHTML = `<div class="muted" style="font-size:11px;">暂无渠道数据。</div>`;
    return;
  }

  $("#channelChart").innerHTML = rows.map(item => `
    <div class="bar-row"><span>${escapeHtml(item.channel)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.max(item.rate, item.offers ? 4 : 0)}%"></div></div><strong>${item.offers}/${item.total}</strong></div>`).join("");
}

function renderTrendChart() {
  const months = [];
  const now = new Date();

  for (let i = 5; i >= 0; i -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`,
      label: `${date.getMonth() + 1}月`,
      count: 0
    });
  }

  data.applications.forEach(item => {
    const target = months.find(month => month.key === (item.applyDate || "").slice(0, 7));
    if (target) target.count += 1;
  });

  const max = Math.max(...months.map(item => item.count), 1);

  $("#trendChart").innerHTML = months.map(item => {
    const height = item.count ? Math.max((item.count / max) * 135, 8) : 3;
    return `<div class="trend-col"><div class="trend-bar-wrap"><div class="trend-bar" style="height:${height}px"></div></div><div class="trend-count">${item.count}</div><div class="trend-label">${item.label}</div></div>`;
  }).join("");
}

function renderDashboardUpcoming() {
  const rows = getUpcomingReminders(7).slice(0, 5);

  $("#dashboardUpcoming").innerHTML = rows.length ? rows.map(item => {
    const app = getApplicationById(item.applicationId);
    return `<button class="mini-item" onclick="editReminder('${item.id}')"><div class="mini-item-title">${escapeHtml(item.title)}</div><div class="mini-item-meta">${escapeHtml(formatDate(item.date))}${item.time ? ` ${escapeHtml(item.time)}` : ""}${app ? ` · ${escapeHtml(app.company)}` : ""}</div></button>`;
  }).join("") : `<div class="muted" style="font-size:11px;">未来 7 天没有待办。</div>`;
}

function renderTopicCloud() {
  const counts = new Map();
  data.questions.forEach(item => item.tags.forEach(tag => {
    const clean = String(tag || "").trim();
    if (clean) counts.set(clean, (counts.get(clean) || 0) + 1);
  }));

  const tags = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  $("#topicCloud").innerHTML = tags.length ? tags.map(([tag, count]) => `<span class="topic-tag">${escapeHtml(tag)} · ${count}</span>`).join("") : `<div class="muted" style="font-size:11px;">给题库添加标签后自动统计。</div>`;
}

/* ========== 投递管理 ========== */

function renderApplicationFilters() {
  const current = $("#applicationLocationFilter").value;
  const locations = [...new Set(data.applications.map(item => (item.location || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  $("#applicationLocationFilter").innerHTML = `<option value="">全部地点</option>` + locations.map(item => `<option>${escapeHtml(item)}</option>`).join("");
  if (locations.includes(current)) $("#applicationLocationFilter").value = current;
}

function getFilteredApplications() {
  const keyword = $("#applicationSearch").value.trim().toLowerCase();
  const status = $("#applicationStatusFilter").value;
  const priority = $("#applicationPriorityFilter").value;
  const location = $("#applicationLocationFilter").value;
  const weight = { high: 3, medium: 2, low: 1 };

  return [...data.applications].filter(item => {
    const text = [item.company, item.role, item.roleType, item.channel, item.location, item.note, item.expectedResult].join(" ").toLowerCase();
    return (!keyword || text.includes(keyword)) && (!status || item.status === status) && (!priority || item.priority === priority) && (!location || item.location === location);
  }).sort((a, b) => {
    const p = weight[b.priority] - weight[a.priority];
    return p || (new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  });
}

function renderApplications() {
  const rows = getFilteredApplications();

  if (!rows.length) {
    $("#applicationsTable").innerHTML = `<div class="empty-state"><div class="empty-emoji">📮</div><div class="empty-title">${data.applications.length ? "没有符合条件的投递" : "还没有投递记录"}</div><div>${data.applications.length ? "调整筛选条件试试看。" : "点击“新增投递”开始记录。"}</div></div>`;
    return;
  }

  $("#applicationsTable").innerHTML = `<table><thead><tr><th>公司 / 岗位</th><th>优先级</th><th>投递时间</th><th>状态</th><th>当前进度</th><th>地点</th><th>最近更新</th><th>操作</th></tr></thead><tbody>${rows.map(item => {
    const latestStage = [...item.stages].sort((a, b) => (b.date || "").localeCompare(a.date || ""))[0];
    return `<tr>
      <td><div class="company-cell"><div class="company-avatar">${escapeHtml(getInitial(item.company))}</div><div><button class="link-button" onclick="openDrawer('${item.id}')">${escapeHtml(item.company)}</button><div class="company-meta">${escapeHtml(item.role)}</div></div></div></td>
      <td><span class="priority-badge priority-${item.priority}">${escapeHtml(PRIORITY_MAP[item.priority])}</span></td>
      <td>${escapeHtml(formatDate(item.applyDate))}</td>
      <td><span class="status-badge status-${item.status}"><span class="status-dot"></span>${escapeHtml(STATUS_MAP[item.status])}</span></td>
      <td>${escapeHtml(latestStage?.name || "—")}</td>
      <td>${escapeHtml(item.location || "—")}</td>
      <td>${escapeHtml(formatDateTime(item.updatedAt))}</td>
      <td><button class="btn btn-sm" onclick="editApplication('${item.id}')">编辑</button></td>
    </tr>`;
  }).join("")}</tbody></table>`;
}

function openAddApplicationModal() {
  $("#applicationForm").reset();
  $("#applicationId").value = "";
  $("#status").value = "applied";
  $("#priority").value = "medium";
  $("#applyDate").value = todayKey();
  $("#applicationModalTitle").textContent = "新增投递";
  openModal("applicationModal");
}

function editApplication(id) {
  const item = getApplicationById(id);
  if (!item) return;

  $("#applicationId").value = item.id;
  $("#company").value = item.company;
  $("#role").value = item.role;
  $("#roleType").value = item.roleType;
  $("#applyDate").value = item.applyDate;
  $("#channel").value = item.channel;
  $("#location").value = item.location;
  $("#salary").value = item.salary;
  $("#priority").value = item.priority;
  $("#status").value = item.status;
  $("#expectedResult").value = item.expectedResult;
  $("#jobUrl").value = item.jobUrl;
  $("#note").value = item.note;
  $("#applicationModalTitle").textContent = "编辑投递";
  openModal("applicationModal");
}

function saveApplicationFromForm() {
  if (!$("#applicationForm").reportValidity()) return;

  const id = $("#applicationId").value;
  const now = new Date().toISOString();
  const payload = {
    company: $("#company").value.trim(),
    role: $("#role").value.trim(),
    roleType: $("#roleType").value.trim(),
    applyDate: $("#applyDate").value,
    channel: $("#channel").value,
    location: $("#location").value.trim(),
    salary: $("#salary").value.trim(),
    priority: $("#priority").value,
    status: $("#status").value,
    expectedResult: $("#expectedResult").value.trim(),
    jobUrl: $("#jobUrl").value.trim(),
    note: $("#note").value.trim()
  };

  if (id) {
    const index = data.applications.findIndex(item => item.id === id);
    if (index >= 0) data.applications[index] = { ...data.applications[index], ...payload, updatedAt: now };
  } else {
    data.applications.unshift({ id: createId("app"), ...payload, createdAt: now, updatedAt: now, stages: [] });
  }

  saveData();
  closeModal("applicationModal");
  renderAll();
  showToast(id ? "投递信息已更新" : "投递已添加");
}

function deleteApplication(id) {
  const item = getApplicationById(id);
  if (!item || !confirm(`确定删除「${item.company} · ${item.role}」吗？`)) return;

  data.applications = data.applications.filter(app => app.id !== id);
  data.reminders = data.reminders.map(reminder => reminder.applicationId === id ? { ...reminder, applicationId: "" } : reminder);
  data.questions = data.questions.map(question => question.companyApplicationId === id ? { ...question, companyApplicationId: "" } : question);

  saveData();
  closeDrawer();
  renderAll();
  showToast("投递记录已删除");
}

/* ========== 详情抽屉与招聘流程 ========== */

function openDrawer(id) {
  const item = getApplicationById(id);
  if (!item) return;
  activeApplicationId = id;
  $("#drawerHeaderTitle").textContent = `${item.company} · ${item.role}`;
  $("#drawerBody").innerHTML = buildDrawerContent(item);
  $("#drawerBackdrop").classList.add("show");
}

function closeDrawer() {
  $("#drawerBackdrop").classList.remove("show");
  activeApplicationId = null;
}

function refreshDrawerIfOpen() {
  if (!$("#drawerBackdrop").classList.contains("show") || !activeApplicationId) return;
  const item = getApplicationById(activeApplicationId);
  if (!item) return closeDrawer();
  $("#drawerHeaderTitle").textContent = `${item.company} · ${item.role}`;
  $("#drawerBody").innerHTML = buildDrawerContent(item);
}

function buildDrawerContent(item) {
  const stages = [...item.stages].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const linkedReminders = data.reminders.filter(reminder => reminder.applicationId === item.id).sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));

  const timeline = stages.length ? stages.map(stage => `
    <div class="timeline-item"><div class="timeline-dot"></div><div class="timeline-card">
      <div class="timeline-top"><div><div class="timeline-stage">${escapeHtml(stage.name)}</div><div class="company-meta">${escapeHtml(stage.result || "结果未填写")}${stage.format ? ` · ${escapeHtml(stage.format)}` : ""}${stage.duration ? ` · ${escapeHtml(stage.duration)}` : ""}</div></div><div class="timeline-date">${escapeHtml(formatDate(stage.date))}</div></div>
      ${stage.interviewer ? `<div class="company-meta" style="margin-top:6px">面试官：${escapeHtml(stage.interviewer)}</div>` : ""}
      ${stage.questions ? `<div class="timeline-section"><strong>面试问题</strong><p>${escapeHtml(stage.questions)}</p></div>` : ""}
      ${stage.reflection ? `<div class="timeline-section"><strong>复盘</strong><p>${escapeHtml(stage.reflection)}</p></div>` : ""}
      ${stage.notes ? `<div class="timeline-section"><strong>其他记录</strong><p>${escapeHtml(stage.notes)}</p></div>` : ""}
      <div class="timeline-actions"><button class="btn btn-sm" onclick="openEditStageModal('${item.id}','${stage.id}')">编辑</button><button class="btn btn-sm" onclick="stageToQuestion('${item.id}','${stage.id}')">沉淀到题库</button><button class="btn btn-sm btn-danger" onclick="deleteStage('${item.id}','${stage.id}')">删除</button></div>
    </div></div>`).join("") : `<div class="empty-state"><div class="empty-emoji">🧭</div><div class="empty-title">还没有流程记录</div><div>添加笔试、一面、二面、HR 面等节点。</div></div>`;

  const reminders = linkedReminders.length ? linkedReminders.slice(0, 5).map(reminder => `<button class="mini-item" onclick="editReminder('${reminder.id}')"><div class="mini-item-title">${escapeHtml(reminder.title)}</div><div class="mini-item-meta">${escapeHtml(formatDate(reminder.date))}${reminder.time ? ` ${escapeHtml(reminder.time)}` : ""}${reminder.done ? " · 已完成" : ""}</div></button>`).join("") : `<div class="muted" style="font-size:11px">暂无关联提醒。</div>`;

  return `<section class="detail-hero">
    <div class="detail-title"><div class="company-avatar" style="width:43px;height:43px">${escapeHtml(getInitial(item.company))}</div><div><h2>${escapeHtml(item.company)}</h2><div class="detail-sub">${escapeHtml(item.role)}${item.roleType ? ` · ${escapeHtml(item.roleType)}` : ""}</div></div></div>
    <div class="button-row" style="margin-top:12px"><span class="status-badge status-${item.status}"><span class="status-dot"></span>${escapeHtml(STATUS_MAP[item.status])}</span><span class="priority-badge priority-${item.priority}">${escapeHtml(PRIORITY_MAP[item.priority])}</span></div>
    <div class="detail-grid">
      <div class="detail-kv"><div class="detail-kv-label">投递时间</div><div class="detail-kv-value">${escapeHtml(formatDate(item.applyDate))}</div></div>
      <div class="detail-kv"><div class="detail-kv-label">投递渠道</div><div class="detail-kv-value">${escapeHtml(item.channel || "—")}</div></div>
      <div class="detail-kv"><div class="detail-kv-label">工作地点</div><div class="detail-kv-value">${escapeHtml(item.location || "—")}</div></div>
      <div class="detail-kv"><div class="detail-kv-label">薪资范围</div><div class="detail-kv-value">${escapeHtml(item.salary || "—")}</div></div>
      <div class="detail-kv"><div class="detail-kv-label">最终结果</div><div class="detail-kv-value">${escapeHtml(item.expectedResult || "—")}</div></div>
      <div class="detail-kv"><div class="detail-kv-label">最近更新</div><div class="detail-kv-value">${escapeHtml(formatDateTime(item.updatedAt))}</div></div>
    </div>
    ${item.note ? `<div class="detail-kv" style="margin-top:9px"><div class="detail-kv-label">备注</div><div class="detail-kv-value" style="white-space:pre-wrap">${escapeHtml(item.note)}</div></div>` : ""}
    <div class="button-row" style="margin-top:11px">${item.jobUrl ? `<a class="btn btn-sm" href="${escapeHtml(item.jobUrl)}" target="_blank" rel="noopener noreferrer">岗位链接 ↗</a>` : ""}<button class="btn btn-sm" onclick="editApplication('${item.id}')">编辑投递</button><button class="btn btn-sm" onclick="openAddReminderModal('${item.id}')">添加提醒</button><button class="btn btn-sm btn-danger" onclick="deleteApplication('${item.id}')">删除投递</button></div>
  </section>
  <div class="timeline-head"><h3 class="section-title" style="margin:0">招聘流程 Timeline</h3><button class="btn btn-sm btn-primary" onclick="openAddStageModal('${item.id}')">＋ 新增流程</button></div>
  <div class="timeline">${timeline}</div>
  <div class="timeline-head"><h3 class="section-title" style="margin:0">关联提醒</h3><button class="btn btn-sm" onclick="openAddReminderModal('${item.id}')">＋ 新增提醒</button></div>
  <div class="mini-list">${reminders}</div>`;
}

function openAddStageModal(applicationId) {
  $("#stageForm").reset();
  $("#stageApplicationId").value = applicationId;
  $("#stageId").value = "";
  $("#stageDate").value = todayKey();
  $("#stageModalTitle").textContent = "新增流程";
  openModal("stageModal");
}

function openEditStageModal(applicationId, stageId) {
  const app = getApplicationById(applicationId);
  const stage = app?.stages.find(item => item.id === stageId);
  if (!stage) return;

  $("#stageApplicationId").value = applicationId;
  $("#stageId").value = stage.id;
  $("#stageName").value = stage.name;
  $("#stageDate").value = stage.date;
  $("#stageResult").value = stage.result;
  $("#stageFormat").value = stage.format;
  $("#stageInterviewer").value = stage.interviewer;
  $("#stageDuration").value = stage.duration;
  $("#stageQuestions").value = stage.questions;
  $("#stageReflection").value = stage.reflection;
  $("#stageNotes").value = stage.notes;
  $("#stageModalTitle").textContent = "编辑流程";
  openModal("stageModal");
}

function saveStageFromForm() {
  if (!$("#stageForm").reportValidity()) return;

  const applicationId = $("#stageApplicationId").value;
  const stageId = $("#stageId").value;
  const app = getApplicationById(applicationId);
  if (!app) return;

  const now = new Date().toISOString();
  const payload = {
    name: $("#stageName").value.trim(),
    date: $("#stageDate").value,
    result: $("#stageResult").value.trim(),
    format: $("#stageFormat").value.trim(),
    interviewer: $("#stageInterviewer").value.trim(),
    duration: $("#stageDuration").value.trim(),
    questions: $("#stageQuestions").value.trim(),
    reflection: $("#stageReflection").value.trim(),
    notes: $("#stageNotes").value.trim()
  };

  if (stageId) {
    const index = app.stages.findIndex(item => item.id === stageId);
    if (index >= 0) app.stages[index] = { ...app.stages[index], ...payload, updatedAt: now };
  } else {
    app.stages.push({ id: createId("stage"), ...payload, createdAt: now, updatedAt: now });
  }

  app.updatedAt = now;
  saveData();
  closeModal("stageModal");
  renderAll();
  showToast(stageId ? "流程已更新" : "流程已添加");
}

function deleteStage(applicationId, stageId) {
  const app = getApplicationById(applicationId);
  const stage = app?.stages.find(item => item.id === stageId);
  if (!stage || !confirm(`确定删除流程「${stage.name}」吗？`)) return;
  app.stages = app.stages.filter(item => item.id !== stageId);
  app.updatedAt = new Date().toISOString();
  saveData();
  renderAll();
}

function stageToQuestion(applicationId, stageId) {
  const app = getApplicationById(applicationId);
  const stage = app?.stages.find(item => item.id === stageId);
  if (!app || !stage) return;

  openAddQuestionModal();
  $("#questionCompany").value = applicationId;
  $("#questionStage").value = stage.name;
  $("#questionText").value = stage.questions || `${app.company} ${stage.name}面试问题`;
  $("#questionReflection").value = stage.reflection;
}


/* ========== 日历提醒 ========== */

function renderReminderApplicationOptions() {
  const current = $("#reminderApplication").value;
  $("#reminderApplication").innerHTML = `<option value="">不关联投递</option>` + data.applications
    .slice()
    .sort((a, b) => a.company.localeCompare(b.company, "zh-CN"))
    .map(item => `<option value="${item.id}">${escapeHtml(item.company)} · ${escapeHtml(item.role)}</option>`)
    .join("");

  if (data.applications.some(item => item.id === current)) $("#reminderApplication").value = current;
}

function openAddReminderModal(applicationId = "", presetDate = "") {
  $("#reminderForm").reset();
  $("#reminderId").value = "";
  $("#reminderDate").value = presetDate || todayKey();
  $("#reminderApplication").value = applicationId || "";
  $("#reminderModalTitle").textContent = "新增提醒";
  openModal("reminderModal");
}

function editReminder(id) {
  const item = data.reminders.find(reminder => reminder.id === id);
  if (!item) return;

  $("#reminderId").value = item.id;
  $("#reminderTitle").value = item.title;
  $("#reminderDate").value = item.date;
  $("#reminderTime").value = item.time;
  $("#reminderApplication").value = item.applicationId;
  $("#reminderNote").value = item.note;
  $("#reminderModalTitle").textContent = "编辑提醒";
  openModal("reminderModal");
}

function saveReminderFromForm() {
  if (!$("#reminderForm").reportValidity()) return;

  const id = $("#reminderId").value;
  const now = new Date().toISOString();
  const payload = {
    title: $("#reminderTitle").value.trim(),
    date: $("#reminderDate").value,
    time: $("#reminderTime").value,
    applicationId: $("#reminderApplication").value,
    note: $("#reminderNote").value.trim()
  };

  if (id) {
    const index = data.reminders.findIndex(item => item.id === id);
    if (index >= 0) data.reminders[index] = { ...data.reminders[index], ...payload, updatedAt: now };
  } else {
    data.reminders.push({
      id: createId("rem"),
      ...payload,
      done: false,
      createdAt: now,
      updatedAt: now
    });
  }

  saveData();
  closeModal("reminderModal");
  renderAll();
  showToast(id ? "提醒已更新" : "提醒已添加");
}

function toggleReminderDone(id) {
  const item = data.reminders.find(reminder => reminder.id === id);
  if (!item) return;
  item.done = !item.done;
  item.updatedAt = new Date().toISOString();
  saveData();
  renderAll();
}

function deleteReminder(id) {
  const item = data.reminders.find(reminder => reminder.id === id);
  if (!item || !confirm(`确定删除提醒「${item.title}」吗？`)) return;
  data.reminders = data.reminders.filter(reminder => reminder.id !== id);
  saveData();
  renderAll();
}

function moveCalendarMonth(offset) {
  calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + offset, 1);
  renderCalendar();
}

function renderCalendar() {
  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();
  $("#calendarTitle").textContent = `${year} 年 ${month + 1} 月`;

  const firstDay = new Date(year, month, 1);
  const mondayIndex = (firstDay.getDay() + 6) % 7;
  const gridStart = new Date(year, month, 1 - mondayIndex);
  const cells = [];

  for (let i = 0; i < 42; i += 1) {
    const date = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    const key = toDateKey(date);
    const reminders = data.reminders
      .filter(item => item.date === key)
      .sort((a, b) => (a.time || "").localeCompare(b.time || ""));

    cells.push(`<div class="calendar-cell ${date.getMonth() !== month ? "other-month" : ""} ${key === todayKey() ? "today" : ""}" ondblclick="openAddReminderModal('', '${key}')" title="双击添加提醒">
      <div class="calendar-day">${date.getDate()}</div>
      ${reminders.slice(0, 4).map(reminder => `<button class="calendar-event ${reminder.done ? "done" : ""}" onclick="editReminder('${reminder.id}')">${reminder.time ? `${escapeHtml(reminder.time)} ` : ""}${escapeHtml(reminder.title)}</button>`).join("")}
      ${reminders.length > 4 ? `<div class="company-meta">+${reminders.length - 4} 条</div>` : ""}
    </div>`);
  }

  $("#calendarGrid").innerHTML = cells.join("");
  renderUpcomingReminders();
}

function getUpcomingReminders(days = 30) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + days);

  return data.reminders
    .filter(item => {
      if (item.done || !item.date) return false;
      const date = new Date(`${item.date}T00:00:00`);
      return date >= start && date <= end;
    })
    .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
}

function renderUpcomingReminders() {
  const overdue = data.reminders
    .filter(item => !item.done && item.date && item.date < todayKey())
    .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));

  const rows = [...overdue, ...getUpcomingReminders(30)].slice(0, 12);

  $("#upcomingReminderList").innerHTML = rows.length ? rows.map(item => {
    const app = getApplicationById(item.applicationId);
    return `<div class="mini-item">
      <div class="mini-item-title">${escapeHtml(item.title)}</div>
      <div class="mini-item-meta">${item.date < todayKey() ? "已逾期 · " : ""}${escapeHtml(formatDate(item.date))}${item.time ? ` ${escapeHtml(item.time)}` : ""}${app ? `<br>${escapeHtml(app.company)} · ${escapeHtml(app.role)}` : ""}${item.note ? `<br>${escapeHtml(item.note)}` : ""}</div>
      <div class="mini-item-actions"><button class="btn btn-sm" onclick="toggleReminderDone('${item.id}')">完成</button><button class="btn btn-sm" onclick="editReminder('${item.id}')">编辑</button><button class="btn btn-sm btn-danger" onclick="deleteReminder('${item.id}')">删除</button></div>
    </div>`;
  }).join("") : `<div class="muted" style="font-size:11px">暂无近期事项。</div>`;
}

async function requestNotificationPermission() {
  if (!("Notification" in window)) {
    alert("当前浏览器不支持系统通知。");
    return;
  }

  const permission = await Notification.requestPermission();
  if (permission === "granted") {
    showToast("已开启浏览器提醒");
    checkDueNotifications(true);
  } else {
    showToast("未开启浏览器提醒");
  }
}

function checkDueNotifications(force = false) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;

  const key = `autumn_tracker_notified_${todayKey()}`;
  if (!force && sessionStorage.getItem(key)) return;

  const due = data.reminders.filter(item => !item.done && item.date && item.date <= todayKey());
  if (!due.length) return;

  new Notification("秋招 Tracker 提醒", {
    body: `${due[0].title}${due.length > 1 ? `，另外还有 ${due.length - 1} 条待办` : ""}`
  });

  sessionStorage.setItem(key, "1");
}

function exportIcs() {
  const events = data.reminders.filter(item => !item.done && item.date);
  if (!events.length) {
    alert("没有可导出的未完成提醒。");
    return;
  }

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Autumn Recruitment Tracker//CN",
    "CALSCALE:GREGORIAN"
  ];

  events.forEach(item => {
    const startDate = item.date.replaceAll("-", "");
    const startTime = (item.time || "09:00").replace(":", "") + "00";
    const endDate = new Date(`${item.date}T${item.time || "09:00"}:00`);
    endDate.setHours(endDate.getHours() + 1);

    const endStamp = `${toDateKey(endDate).replaceAll("-", "")}T${String(endDate.getHours()).padStart(2, "0")}${String(endDate.getMinutes()).padStart(2, "0")}00`;
    const app = getApplicationById(item.applicationId);
    const description = [app ? getApplicationLabel(item.applicationId) : "", item.note]
      .filter(Boolean)
      .join(" - ")
      .replaceAll("\n", "\\n")
      .replaceAll(",", "\\,");

    lines.push(
      "BEGIN:VEVENT",
      `UID:${item.id}@autumn-tracker`,
      `DTSTAMP:${new Date().toISOString().replaceAll("-", "").replaceAll(":", "").replace(/\.\d{3}Z$/, "Z")}`,
      `DTSTART:${startDate}T${startTime}`,
      `DTEND:${endStamp}`,
      `SUMMARY:${item.title.replaceAll(",", "\\,")}`,
      `DESCRIPTION:${description}`,
      "END:VEVENT"
    );
  });

  lines.push("END:VCALENDAR");

  downloadFile(lines.join("\r\n"), `autumn-recruitment-calendar-${todayKey()}.ics`, "text/calendar;charset=utf-8");
  showToast("日历文件已导出");
}

/* ========== 面试题库与复盘 ========== */

function renderQuestionFilters() {
  const filterCurrent = $("#questionCompanyFilter").value;
  const formCurrent = $("#questionCompany").value;
  const options = data.applications
    .slice()
    .sort((a, b) => a.company.localeCompare(b.company, "zh-CN"))
    .map(item => `<option value="${item.id}">${escapeHtml(item.company)} · ${escapeHtml(item.role)}</option>`)
    .join("");

  $("#questionCompanyFilter").innerHTML = `<option value="">全部公司</option>${options}`;
  $("#questionCompany").innerHTML = `<option value="">不关联公司</option>${options}`;

  if (data.applications.some(item => item.id === filterCurrent)) $("#questionCompanyFilter").value = filterCurrent;
  if (data.applications.some(item => item.id === formCurrent)) $("#questionCompany").value = formCurrent;
}

function getFilteredQuestions() {
  const keyword = $("#questionSearch").value.trim().toLowerCase();
  const category = $("#questionCategoryFilter").value;
  const companyId = $("#questionCompanyFilter").value;

  return sortByUpdatedAt(data.questions).filter(item => {
    const text = [item.text, item.answer, item.reflection, item.category, item.stage, ...item.tags].join(" ").toLowerCase();
    return (!keyword || text.includes(keyword)) && (!category || item.category === category) && (!companyId || item.companyApplicationId === companyId);
  });
}

function renderQuestions() {
  const rows = getFilteredQuestions();
  const difficultyMap = { easy: "基础", medium: "中等", hard: "困难" };

  if (!rows.length) {
    $("#questionGrid").innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-emoji">🧠</div><div class="empty-title">${data.questions.length ? "没有符合条件的题目" : "题库还是空的"}</div><div>把面试问题、答案和复盘沉淀下来。</div></div>`;
    return;
  }

  $("#questionGrid").innerHTML = rows.map(item => {
    const app = getApplicationById(item.companyApplicationId);
    return `<article class="question-card">
      <div class="question-top"><div><div class="question-category">${escapeHtml(item.category)}</div><h3 class="question-title">${escapeHtml(item.text)}</h3><div class="company-meta">${app ? `${escapeHtml(app.company)} · ${escapeHtml(app.role)}` : "通用题库"}${item.stage ? ` · ${escapeHtml(item.stage)}` : ""}</div></div><span class="difficulty-badge difficulty-${item.difficulty}">${difficultyMap[item.difficulty]}</span></div>
      ${item.answer ? `<div class="question-section"><strong>答案思路</strong><p>${escapeHtml(item.answer)}</p></div>` : ""}
      ${item.reflection ? `<div class="question-section"><strong>我的复盘</strong><p>${escapeHtml(item.reflection)}</p></div>` : ""}
      ${item.tags.length ? `<div class="question-tags">${item.tags.map(tag => `<span class="question-tag">${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
      <div class="question-actions"><button class="btn btn-sm" onclick="editQuestion('${item.id}')">编辑</button><button class="btn btn-sm btn-danger" onclick="deleteQuestion('${item.id}')">删除</button></div>
    </article>`;
  }).join("");
}

function openAddQuestionModal() {
  $("#questionForm").reset();
  $("#questionId").value = "";
  $("#questionDifficulty").value = "medium";
  $("#questionCategory").value = QUESTION_CATEGORIES[0];
  $("#questionModalTitle").textContent = "新增面试记录";
  openModal("questionModal");
}

function editQuestion(id) {
  const item = data.questions.find(question => question.id === id);
  if (!item) return;

  $("#questionId").value = item.id;
  $("#questionCategory").value = item.category;
  $("#questionDifficulty").value = item.difficulty;
  $("#questionCompany").value = item.companyApplicationId;
  $("#questionStage").value = item.stage;
  $("#questionText").value = item.text;
  $("#questionAnswer").value = item.answer;
  $("#questionReflection").value = item.reflection;
  $("#questionTags").value = item.tags.join(", ");
  $("#questionModalTitle").textContent = "编辑面试记录";
  openModal("questionModal");
}

function saveQuestionFromForm() {
  if (!$("#questionForm").reportValidity()) return;

  const id = $("#questionId").value;
  const now = new Date().toISOString();
  const payload = {
    category: $("#questionCategory").value,
    difficulty: $("#questionDifficulty").value,
    companyApplicationId: $("#questionCompany").value,
    stage: $("#questionStage").value.trim(),
    text: $("#questionText").value.trim(),
    answer: $("#questionAnswer").value.trim(),
    reflection: $("#questionReflection").value.trim(),
    tags: $("#questionTags").value.split(/[,，]/).map(tag => tag.trim()).filter(Boolean)
  };

  if (id) {
    const index = data.questions.findIndex(item => item.id === id);
    if (index >= 0) data.questions[index] = { ...data.questions[index], ...payload, updatedAt: now };
  } else {
    data.questions.unshift({ id: createId("q"), ...payload, createdAt: now, updatedAt: now });
  }

  saveData();
  closeModal("questionModal");
  renderAll();
  showToast(id ? "面试记录已更新" : "已加入面试题库");
}

function deleteQuestion(id) {
  if (!confirm("确定删除这条面试记录吗？")) return;
  data.questions = data.questions.filter(question => question.id !== id);
  saveData();
  renderAll();
}

/* ========== 备份与恢复 ========== */

function exportJson() {
  downloadFile(
    JSON.stringify({ ...data, exportedAt: new Date().toISOString() }, null, 2),
    `autumn-recruitment-v2-backup-${todayKey()}.json`,
    "application/json;charset=utf-8"
  );
  showToast("完整 JSON 备份已导出");
}

function exportCsv() {
  const headers = ["公司", "岗位", "岗位类型", "优先级", "投递时间", "投递渠道", "地点", "薪资范围", "状态", "最终结果", "岗位链接", "备注", "流程数量", "最近更新"];
  const rows = data.applications.map(item => [
    item.company,
    item.role,
    item.roleType,
    PRIORITY_MAP[item.priority],
    item.applyDate,
    item.channel,
    item.location,
    item.salary,
    STATUS_MAP[item.status],
    item.expectedResult,
    item.jobUrl,
    item.note,
    item.stages.length,
    item.updatedAt
  ]);

  const csv = [headers, ...rows].map(row => row.map(csvEscape).join(",")).join("\n");
  downloadFile("\uFEFF" + csv, `autumn-recruitment-applications-${todayKey()}.csv`, "text/csv;charset=utf-8");
  showToast("投递 CSV 已导出");
}

async function importJson(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    const parsed = JSON.parse(await file.text());
    if (!confirm("导入会覆盖当前浏览器中的全部 V2 本地数据，是否继续？")) return;
    data = normalizeData(parsed);
    saveData();
    renderAll();
    showToast("数据导入成功");
  } catch (error) {
    alert(`导入失败：${error.message || "JSON 格式不正确"}`);
  } finally {
    event.target.value = "";
  }
}

function clearAllLocalData() {
  if (!confirm("确定清空本机全部投递、提醒和题库数据吗？这不会删除云端数据。")) return;
  data = createEmptyData();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  renderAll();
  closeModal("backupModal");
  showToast("本地数据已清空");
}

/* ========== Supabase 云同步 ========== */

function getCloudConfig() {
  try {
    return JSON.parse(localStorage.getItem(CLOUD_CONFIG_KEY) || "{}");
  } catch {
    return {};
  }
}

function loadCloudConfigIntoForm() {
  const config = getCloudConfig();
  $("#supabaseUrl").value = config.url || "";
  $("#supabaseKey").value = config.key || "";
}

function saveCloudConfig() {
  const url = $("#supabaseUrl").value.trim().replace(/\/$/, "");
  const key = $("#supabaseKey").value.trim();

  if (!url || !key) {
    alert("请填写 Supabase Project URL 和 anon / publishable key。");
    return;
  }

  localStorage.setItem(CLOUD_CONFIG_KEY, JSON.stringify({ url, key }));
  initializeCloudIfConfigured(true);
}

async function initializeCloudIfConfigured(showMessage = false) {
  const config = getCloudConfig();
  if (!config.url || !config.key || cloudInitializing) {
    updateCloudUi();
    return;
  }

  cloudInitializing = true;
  setSyncChip("syncing", "连接中");

  try {
    // 使用 Supabase 官方 JS 客户端的 ESM 构建，适合 GitHub Pages 静态部署。
    const module = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");

    supabaseClient = module.createClient(config.url, config.key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });

    const { data: authData } = await supabaseClient.auth.getSession();
    currentUser = authData.session?.user || null;

    supabaseClient.auth.onAuthStateChange((_event, session) => {
      currentUser = session?.user || null;
      updateCloudUi();
    });

    updateCloudUi();
    if (showMessage) showToast("Supabase 配置已保存");
    if (currentUser) await smartSync();
  } catch (error) {
    console.error("初始化 Supabase 失败：", error);
    setCloudStatus("连接失败", error.message || "无法加载 Supabase");
    setSyncChip("error", "云端异常");
  } finally {
    cloudInitializing = false;
  }
}

async function signUpCloud() {
  if (!supabaseClient) return alert("请先保存 Supabase 配置。");

  const email = $("#cloudEmail").value.trim();
  const password = $("#cloudPassword").value;
  if (!email || !password) return alert("请输入邮箱和密码。");

  setSyncChip("syncing", "注册中");
  const { data: result, error } = await supabaseClient.auth.signUp({ email, password });

  if (error) {
    setCloudStatus("注册失败", error.message);
    setSyncChip("error", "注册失败");
    return;
  }

  currentUser = result.user || null;
  updateCloudUi();

  if (result.session) {
    showToast("注册并登录成功");
    await smartSync();
  } else {
    showToast("注册成功，请先完成邮箱确认再登录");
  }
}

async function signInCloud() {
  if (!supabaseClient) return alert("请先保存 Supabase 配置。");

  const email = $("#cloudEmail").value.trim();
  const password = $("#cloudPassword").value;
  if (!email || !password) return alert("请输入邮箱和密码。");

  setSyncChip("syncing", "登录中");
  const { data: result, error } = await supabaseClient.auth.signInWithPassword({ email, password });

  if (error) {
    setCloudStatus("登录失败", error.message);
    setSyncChip("error", "登录失败");
    return;
  }

  currentUser = result.user;
  updateCloudUi();
  showToast("云端登录成功");
  await smartSync();
}

async function signOutCloud() {
  if (!supabaseClient) return;
  await supabaseClient.auth.signOut();
  currentUser = null;
  updateCloudUi();
  showToast("已退出云端账号");
}

function updateCloudUi() {
  const config = getCloudConfig();
  const configured = Boolean(config.url && config.key);

  if (currentUser) {
    $("#signOutBtn").classList.remove("hidden");
    $("#signInBtn").classList.add("hidden");
    $("#signUpBtn").classList.add("hidden");
    setCloudStatus("已连接", `${currentUser.email || "当前账号"} · 本地修改会自动上传。`);
    setSyncChip("connected", "已登录云端");
  } else {
    $("#signOutBtn").classList.add("hidden");
    $("#signInBtn").classList.remove("hidden");
    $("#signUpBtn").classList.remove("hidden");

    if (configured && supabaseClient) {
      setCloudStatus("配置已就绪", "请登录或注册后开始跨设备同步。");
      setSyncChip("", "云端未登录");
    } else if (configured) {
      setCloudStatus("正在初始化", "正在加载 Supabase。");
      setSyncChip("syncing", "连接中");
    } else {
      setCloudStatus("尚未连接", "先填写 Supabase 配置并登录。");
      setSyncChip("", "仅本地");
    }
  }
}

function setCloudStatus(title, text) {
  $("#cloudStatusCard").innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(text)}</span>`;
}

function setSyncChip(state, text) {
  $("#syncChip").classList.remove("connected", "syncing", "error");
  if (state) $("#syncChip").classList.add(state);
  $("#syncChipText").textContent = text;
}

function scheduleCloudPush() {
  if (!supabaseClient || !currentUser) return;
  clearTimeout(cloudPushTimer);
  cloudPushTimer = setTimeout(() => pushCloudData(false), 900);
}

async function fetchCloudRow() {
  if (!supabaseClient || !currentUser) return null;

  const { data: row, error } = await supabaseClient
    .from("user_data")
    .select("data, updated_at")
    .eq("user_id", currentUser.id)
    .maybeSingle();

  if (error) throw error;
  return row;
}

async function smartSync() {
  if (!supabaseClient || !currentUser) {
    updateCloudUi();
    return;
  }

  setSyncChip("syncing", "同步中");

  try {
    const row = await fetchCloudRow();

    if (!row?.data) {
      await pushCloudData(false);
      showToast("已首次同步到云端");
      return;
    }

    const cloudData = normalizeData(row.data);
    const localTime = new Date(data.meta.updatedAt || 0).getTime();
    const cloudTime = new Date(cloudData.meta.updatedAt || 0).getTime();
    const localHasContent = data.applications.length + data.reminders.length + data.questions.length > 0;
    const cloudHasContent = cloudData.applications.length + cloudData.reminders.length + cloudData.questions.length > 0;

    // 新设备第一次登录时，本地通常是刚创建的空数据。
    // 此时即使本地时间戳更新，也必须优先拉取已有云端数据，避免误覆盖。
    if (!localHasContent && cloudHasContent) {
      data = cloudData;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      renderAll();
      setSyncChip("connected", "云端已更新");
      showToast("已在新设备拉取云端数据");
    } else if (localHasContent && !cloudHasContent) {
      await pushCloudData(false);
      showToast("已上传本地数据");
    } else if (cloudTime > localTime) {
      data = cloudData;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      renderAll();
      setSyncChip("connected", "云端已更新");
      showToast("已拉取较新的云端数据");
    } else if (localTime > cloudTime) {
      await pushCloudData(false);
      showToast("已上传较新的本地数据");
    } else {
      setSyncChip("connected", "已同步");
    }
  } catch (error) {
    console.error("智能同步失败：", error);
    setSyncChip("error", "同步失败");
    setCloudStatus("同步失败", error.message || "请检查配置、网络和 RLS。");
  }
}

async function pushCloudData(ask = false) {
  if (!supabaseClient || !currentUser) {
    if (ask) alert("请先配置 Supabase 并登录。");
    return;
  }

  if (ask && !confirm("确定用当前本地数据覆盖云端数据吗？")) return;

  setSyncChip("syncing", "上传中");

  try {
    const { error } = await supabaseClient.from("user_data").upsert(
      {
        user_id: currentUser.id,
        data: JSON.parse(JSON.stringify(data)),
        updated_at: new Date().toISOString()
      },
      { onConflict: "user_id" }
    );

    if (error) throw error;
    setSyncChip("connected", "已同步");
    if (ask) showToast("本地数据已覆盖到云端");
  } catch (error) {
    console.error("上传云端失败：", error);
    setSyncChip("error", "上传失败");
    if (ask) alert(`上传失败：${error.message || "未知错误"}`);
  }
}

async function pullCloudData(ask = false) {
  if (!supabaseClient || !currentUser) {
    if (ask) alert("请先配置 Supabase 并登录。");
    return;
  }

  if (ask && !confirm("确定用云端数据覆盖当前本地数据吗？")) return;

  setSyncChip("syncing", "下载中");

  try {
    const row = await fetchCloudRow();

    if (!row?.data) {
      alert("云端还没有数据。");
      setSyncChip("connected", "已登录");
      return;
    }

    data = normalizeData(row.data);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    renderAll();
    setSyncChip("connected", "已同步");
    if (ask) showToast("云端数据已覆盖到本地");
  } catch (error) {
    console.error("下载云端失败：", error);
    setSyncChip("error", "下载失败");
    if (ask) alert(`下载失败：${error.message || "未知错误"}`);
  }
}

/* ========== 暴露给动态 HTML 使用的函数 ========== */

window.openDrawer = openDrawer;
window.editApplication = editApplication;
window.deleteApplication = deleteApplication;
window.openAddStageModal = openAddStageModal;
window.openEditStageModal = openEditStageModal;
window.deleteStage = deleteStage;
window.stageToQuestion = stageToQuestion;
window.openAddReminderModal = openAddReminderModal;
window.editReminder = editReminder;
window.toggleReminderDone = toggleReminderDone;
window.deleteReminder = deleteReminder;
window.editQuestion = editQuestion;
window.deleteQuestion = deleteQuestion;
