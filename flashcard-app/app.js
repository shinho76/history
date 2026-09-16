"use strict";

/* ============================================================
   저장소 (localStorage)
   ============================================================ */
const SETS_INDEX_KEY = "korcard_sets_index_v1";

function loadSetsIndex() {
  try {
    return JSON.parse(localStorage.getItem(SETS_INDEX_KEY)) || [];
  } catch (e) {
    return [];
  }
}
function saveSetsIndex(list) {
  localStorage.setItem(SETS_INDEX_KEY, JSON.stringify(list));
}
function setDataKey(id) {
  return "korcard_set_" + id;
}
function loadSetData(id) {
  try {
    return JSON.parse(localStorage.getItem(setDataKey(id)));
  } catch (e) {
    return null;
  }
}
function saveSetData(id, data) {
  localStorage.setItem(setDataKey(id), JSON.stringify(data));
}
function deleteSet(id) {
  localStorage.removeItem(setDataKey(id));
  saveSetsIndex(loadSetsIndex().filter((s) => s.id !== id));
}

function hashText(text) {
  let h1 = 0xdeadbeef ^ text.length;
  let h2 = 0x41c6ce57 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return "s" + (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/* ============================================================
   텍스트 파싱 & 키워드 추출
   ============================================================ */
const FILLER_WORDS = new Set([
  "매우", "반드시", "다시", "또한", "그러나", "하지만", "한편", "이는", "이에",
  "그리고", "즉", "특히", "결국", "그러므로", "따라서", "이러한", "이렇게",
]);

const TERM_SUFFIXES = [
  "사업", "정책", "운동", "주의", "조약", "회의", "협정", "사변", "사건",
  "계획", "혁명", "대전", "통치", "총독부", "기구", "단체", "제도", "전쟁",
  "회", "당", "법", "령",
];

function splitPages(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const pageHeaderRe = /^##\s*페이지\s*([^\n(]+?)\s*(?:\(.*\))?\s*$/;
  let currentPage = "미상";
  const blocks = [];
  let buf = [];
  function flush() {
    if (buf.length) blocks.push({ page: currentPage, text: buf.join("\n") });
    buf = [];
  }
  for (const line of lines) {
    const m = line.match(pageHeaderRe);
    if (m) {
      flush();
      currentPage = m[1].trim();
      continue;
    }
    buf.push(line);
  }
  flush();
  return blocks;
}

function splitParagraphs(blockText) {
  return blockText
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && p !== "---" && !/^#+\s/.test(p));
}

function stripMarkdown(paragraph) {
  return paragraph
    .replace(/\*\*/g, "")
    .replace(/^-{1,3}\s?/gm, "")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function trimParticle(phrase) {
  return phrase.replace(/(을|를|이|가|은|는|에게|으로|로|의|에서|와|과)$/u, "").trim();
}

function cleanCandidate(raw) {
  return raw
    .replace(/^[\s"'“”·(){}\[\]]+/, "")
    .replace(/[\s"'“”·(){}\[\].,]+$/, "")
    .trim();
}

// 문장형(서술어로 끝나는) 굵은 글씨에서 핵심 명사구를 뽑아낸다.
function extractPhraseFromSentence(raw) {
  let s = raw.replace(/["“”().]/g, " ").trim();
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  if (words.length === 1) return [cleanCandidate(words[0])];
  const last = words[words.length - 1];
  if (/(다|음|함|됨)$/.test(last)) words.pop();
  if (words.length === 0) return [];
  let phrase = trimParticle(words.join(" "));
  phrase = cleanCandidate(phrase);
  if (phrase.length < 2 || phrase.length > 22) return [];
  return [phrase];
}

function extractTermsBySuffix(raw) {
  const found = new Set();
  const pattern = new RegExp("[가-힣A-Za-z0-9]{2,12}(?:" + TERM_SUFFIXES.join("|") + ")", "g");
  let m;
  while ((m = pattern.exec(raw))) {
    const c = cleanCandidate(m[0]);
    if (c.length >= 2) found.add(c);
  }
  const quoted = raw.match(/["“]([^"”]{2,14})["”]/g);
  if (quoted) {
    quoted.forEach((q) => {
      const c = cleanCandidate(q.replace(/["“”]/g, ""));
      if (c.length >= 2) found.add(c);
    });
  }
  return Array.from(found);
}

function extractKeywordsFromBold(rawIn) {
  const raw = rawIn.replace(/\s*\n\s*/g, " ").trim();
  if (!raw || FILLER_WORDS.has(raw)) return [];

  const sentenceLike = /(다|요|음|함|됨)\.?$/.test(raw);

  if (raw.length <= 20 && !sentenceLike) {
    const c = cleanCandidate(raw);
    return c.length >= 2 ? [c] : [];
  }
  if (raw.length <= 45) {
    return extractPhraseFromSentence(raw).concat(extractTermsBySuffix(raw));
  }
  // 너무 긴 문장 전체 강조는 키워드 후보로 보지 않고, 문맥(정의) 용도로만 사용한다.
  return extractTermsBySuffix(raw);
}

function parseKeywords(rawText) {
  const blocks = splitPages(rawText);
  const map = new Map(); // normalizedKeyword -> {keyword, definition, pages:Set}

  blocks.forEach((block) => {
    const paragraphs = splitParagraphs(block.text);
    paragraphs.forEach((paragraph) => {
      const boldRe = /\*\*([\s\S]+?)\*\*/g;
      const bolds = [];
      let m;
      while ((m = boldRe.exec(paragraph))) bolds.push(m[1]);
      if (bolds.length === 0) return;

      const definition = stripMarkdown(paragraph);
      bolds.forEach((b) => {
        extractKeywordsFromBold(b).forEach((kw) => {
          const norm = kw.replace(/\s+/g, " ").trim();
          if (!norm || norm.length < 2 || norm.length > 25) return;
          const key = norm.toLowerCase();
          if (!map.has(key)) {
            map.set(key, { keyword: norm, definition, pages: new Set([block.page]) });
          } else {
            const entry = map.get(key);
            entry.pages.add(block.page);
            if (definition.length > entry.definition.length) entry.definition = definition;
          }
        });
      });
    });
  });

  let idx = 0;
  return Array.from(map.values()).map((v) => ({
    id: "k" + idx++ + "_" + Math.random().toString(36).slice(2, 7),
    keyword: v.keyword,
    definition: v.definition,
    pages: Array.from(v.pages),
  }));
}

// 사람이 직접 검토해 정리한 키워드(sample-data.js의 CURATED_KEYWORDS)를
// 자동 추출 결과와 합친다. 같은 키워드가 이미 있으면 정의/페이지를 보강하고,
// 없으면 새로 추가한다.
function mergeCurated(autoList, curatedList) {
  const map = new Map();
  autoList.forEach((k) => map.set(k.keyword.trim(), { ...k, pages: [...k.pages] }));
  curatedList.forEach((c) => {
    const key = c.keyword.trim();
    if (map.has(key)) {
      const existing = map.get(key);
      existing.definition = c.definition;
      c.pages.forEach((p) => {
        if (!existing.pages.includes(p)) existing.pages.push(p);
      });
    } else {
      map.set(key, {
        id: "kc_" + Math.random().toString(36).slice(2, 8),
        keyword: c.keyword,
        definition: c.definition,
        pages: [...c.pages],
      });
    }
  });
  return Array.from(map.values());
}

/* ============================================================
   전역 상태
   ============================================================ */
const state = {
  view: "home",
  reviewSetId: null, // null이면 새 세트, 값이 있으면 기존 세트 수정
  reviewKeywords: [],
  reviewName: "",
  study: {
    setId: null,
    name: "",
    keywords: [],
    status: {}, // id -> 'known' | 'unknown'
    currentId: null,
    lastId: null,
    busy: false,
  },
};

/* ============================================================
   공통 유틸
   ============================================================ */
const $ = (sel) => document.querySelector(sel);
const views = {
  home: $("#view-home"),
  review: $("#view-review"),
  study: $("#view-study"),
};

function showView(name) {
  Object.entries(views).forEach(([key, el]) => (el.hidden = key !== name));
  state.view = name;
  window.scrollTo({ top: 0 });
}

let toastTimer = null;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2200);
}

function formatPages(pages) {
  if (!pages || pages.length === 0) return "페이지 정보 없음";
  return "p. " + pages.join(", ");
}

/* ============================================================
   홈 화면
   ============================================================ */
function renderHome() {
  const list = loadSetsIndex().slice().sort((a, b) => b.updatedAt - a.updatedAt);
  const ul = $("#set-list");
  const empty = $("#set-list-empty");
  ul.innerHTML = "";
  empty.hidden = list.length > 0;

  list.forEach((meta) => {
    const data = loadSetData(meta.id);
    if (!data) return;
    const total = data.keywords.length;
    const known = data.keywords.filter((k) => data.status[k.id] === "known").length;

    const li = document.createElement("li");
    li.className = "set-item";
    li.innerHTML = `
      <div class="set-item-info">
        <div class="set-item-name">${escapeHtml(meta.name)}</div>
        <div class="set-item-meta">${known} / ${total} 완료 · 키워드 ${total}개</div>
      </div>
      <div class="set-item-actions">
        <button class="btn btn-secondary btn-sm" data-action="study">학습하기</button>
        <button class="btn btn-secondary btn-sm" data-action="edit">키워드 수정</button>
        <button class="btn btn-danger btn-sm" data-action="delete">삭제</button>
      </div>
    `;
    li.querySelector('[data-action="study"]').addEventListener("click", () => enterStudy(meta.id));
    li.querySelector('[data-action="edit"]').addEventListener("click", () => enterReviewForExistingSet(meta.id));
    li.querySelector('[data-action="delete"]').addEventListener("click", () => {
      if (confirm(`"${meta.name}" 세트를 삭제할까요? 학습 기록도 함께 사라져요.`)) {
        deleteSet(meta.id);
        renderHome();
        toast("세트를 삭제했어요.");
      }
    });
    ul.appendChild(li);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function startFromText(rawText, name) {
  const id = hashText(rawText);
  const existing = loadSetData(id);
  if (existing) {
    toast("이미 저장된 세트를 불러왔어요.");
    enterReviewForExistingSet(id);
    return;
  }
  let keywords = parseKeywords(rawText);
  if (rawText === SAMPLE_TEXT && typeof CURATED_KEYWORDS !== "undefined") {
    keywords = mergeCurated(keywords, CURATED_KEYWORDS);
  }
  if (keywords.length === 0) {
    toast("굵게 강조된 키워드를 찾지 못했어요. 텍스트 형식을 확인해 주세요.");
    return;
  }
  state.reviewSetId = id;
  state.reviewKeywords = keywords;
  state.reviewName = name;
  renderReview();
  showView("review");
}

const DEFAULT_SET_NAME = "한국근현대사";

$("#btn-sample").addEventListener("click", () => {
  startFromText(SAMPLE_TEXT, DEFAULT_SET_NAME);
});

$("#file-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    startFromText(String(reader.result), file.name.replace(/\.txt$/i, ""));
  };
  reader.onerror = () => toast("파일을 읽는 중 문제가 발생했어요.");
  reader.readAsText(file, "utf-8");
  e.target.value = "";
});

/* ============================================================
   검수 화면
   ============================================================ */
function enterReviewForExistingSet(id) {
  const data = loadSetData(id);
  if (!data) return;
  state.reviewSetId = id;
  state.reviewKeywords = data.keywords.map((k) => ({ ...k }));
  state.reviewName = data.name;
  renderReview();
  showView("review");
}

function renderReview() {
  $("#review-title").textContent = state.reviewName || "키워드 검수";
  const ul = $("#review-list");
  ul.innerHTML = "";
  state.reviewKeywords.forEach((kw) => ul.appendChild(buildReviewRow(kw)));
  updateReviewCount();
}

function updateReviewCount() {
  $("#review-count").textContent = state.reviewKeywords.length + "개";
}

function buildReviewRow(kw) {
  const li = document.createElement("li");
  li.className = "review-row";
  li.dataset.id = kw.id;
  li.innerHTML = `
    <div class="review-row-top">
      <input type="text" class="kw-input" value="${escapeHtml(kw.keyword)}" placeholder="키워드" />
      <button class="btn-remove" title="삭제">✕</button>
    </div>
    <textarea class="def-input" placeholder="정의/설명">${escapeHtml(kw.definition)}</textarea>
    <div class="review-row-pages">${escapeHtml(formatPages(kw.pages))}</div>
  `;
  li.querySelector(".kw-input").addEventListener("input", (e) => (kw.keyword = e.target.value));
  li.querySelector(".def-input").addEventListener("input", (e) => (kw.definition = e.target.value));
  li.querySelector(".btn-remove").addEventListener("click", () => {
    state.reviewKeywords = state.reviewKeywords.filter((k) => k.id !== kw.id);
    li.remove();
    updateReviewCount();
  });
  return li;
}

$("#btn-add-keyword").addEventListener("click", () => {
  const kw = { id: "k_new_" + Math.random().toString(36).slice(2, 8), keyword: "", definition: "", pages: [] };
  state.reviewKeywords.push(kw);
  $("#review-list").appendChild(buildReviewRow(kw));
  updateReviewCount();
  const rows = $("#review-list").children;
  const lastInput = rows[rows.length - 1].querySelector(".kw-input");
  lastInput.focus();
});

$("#review-back").addEventListener("click", () => {
  showView("home");
  renderHome();
});

$("#btn-start-study").addEventListener("click", () => {
  const cleaned = state.reviewKeywords
    .map((k) => ({ ...k, keyword: k.keyword.trim(), definition: k.definition.trim() }))
    .filter((k) => k.keyword.length > 0);

  if (cleaned.length === 0) {
    toast("최소 1개 이상의 키워드가 필요해요.");
    return;
  }

  const id = state.reviewSetId;
  const prevData = loadSetData(id);
  const prevStatus = prevData ? prevData.status : {};
  const status = {};
  cleaned.forEach((k) => {
    status[k.id] = prevStatus[k.id] === "known" ? "known" : "unknown";
  });

  const data = { id, name: state.reviewName, keywords: cleaned, status };
  saveSetData(id, data);

  const index = loadSetsIndex();
  const existingMeta = index.find((s) => s.id === id);
  if (existingMeta) {
    existingMeta.name = state.reviewName;
    existingMeta.updatedAt = Date.now();
  } else {
    index.push({ id, name: state.reviewName, updatedAt: Date.now() });
  }
  saveSetsIndex(index);

  enterStudy(id);
});

/* ============================================================
   학습 화면 (룰렛 + 스와이프 플래시카드)
   ============================================================ */
function enterStudy(id) {
  const data = loadSetData(id);
  if (!data) {
    toast("세트를 찾을 수 없어요.");
    return;
  }
  state.study.setId = id;
  state.study.name = data.name;
  state.study.keywords = data.keywords;
  state.study.status = data.status;
  state.study.currentId = null;
  state.study.lastId = null;

  showView("study");
  updateProgressUI();
  $("#roulette-overlay").hidden = true;
  pickNextCard(true);
}

function persistStudy() {
  saveSetData(state.study.setId, {
    id: state.study.setId,
    name: state.study.name,
    keywords: state.study.keywords,
    status: state.study.status,
  });
  const index = loadSetsIndex();
  const meta = index.find((s) => s.id === state.study.setId);
  if (meta) {
    meta.updatedAt = Date.now();
    saveSetsIndex(index);
  }
}

function unknownPool() {
  return state.study.keywords.filter((k) => state.study.status[k.id] !== "known");
}

function updateProgressUI() {
  const total = state.study.keywords.length;
  const known = total - unknownPool().length;
  const pct = total === 0 ? 0 : Math.round((known / total) * 100);
  $("#progress-fill").style.width = pct + "%";
  $("#progress-text").textContent = `${known} / ${total} 완료 (${pct}%)`;
}

function findKeyword(id) {
  return state.study.keywords.find((k) => k.id === id);
}

function pickNextCard(skipRoulette) {
  const pool = unknownPool();
  updateProgressUI();

  if (pool.length === 0) {
    showComplete();
    return;
  }

  let candidates = pool;
  if (pool.length > 1 && state.study.lastId) {
    const filtered = pool.filter((k) => k.id !== state.study.lastId);
    if (filtered.length > 0) candidates = filtered;
  }
  const next = candidates[Math.floor(Math.random() * candidates.length)];

  // 카드 내용은 미리 채워 두고(뒤에 숨어 있음), 원형 룰렛이 카드 위에서
  // 돌다가 멈추면 사라지는 방식이라 카드/버튼 위치가 전혀 움직이지 않는다.
  $("#study-stage").hidden = false;
  setCard(next);

  if (skipRoulette) {
    $("#roulette-overlay").hidden = true;
    state.study.busy = false;
  } else {
    spinRoulette(pool, next.keyword, () => {
      $("#roulette-overlay").hidden = true;
      state.study.busy = false;
    });
  }
}

function setCard(kw) {
  state.study.currentId = kw.id;
  state.study.lastId = kw.id;
  const card = $("#card");
  card.classList.remove("flipped");
  $("#card-keyword").textContent = kw.keyword;
  $("#card-definition").textContent = kw.definition || "(정의 없음)";
  $("#card-pages").textContent = formatPages(kw.pages);
  const wrapper = $("#card-wrapper");
  wrapper.style.transition = "none";
  wrapper.style.transform = "translateX(0) rotate(0)";
  wrapper.style.opacity = "1";
  requestAnimationFrame(() => (wrapper.style.transition = ""));
}

// 스핀 도중에 카드/버튼을 누르면 즉시 멈출 수 있도록, 현재 진행 중인 스핀을
// 바로 끝내는 함수를 여기에 보관해 둔다. 스핀이 없을 때는 null.
let activeSpinSkip = null;

// 스핀이 돌고 있으면 즉시 멈추고 true를 반환한다(이번 입력은 스핀을 멈추는
// 데만 쓰고, 뒤집기/판정 등 원래 동작은 수행하지 않는다).
function trySkipSpin() {
  if (activeSpinSkip) {
    activeSpinSkip();
    return true;
  }
  return false;
}

function spinRoulette(pool, finalKeyword, onDone) {
  state.study.busy = true;
  const overlay = $("#roulette-overlay");
  const textEl = $("#roulette-text");
  overlay.hidden = false;

  let timerId = null;
  let finished = false;

  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(timerId);
    activeSpinSkip = null;
    textEl.textContent = finalKeyword;
    onDone();
  }

  const ticks = 14;
  let i = 0;
  function tick() {
    if (i >= ticks) {
      textEl.textContent = finalKeyword;
      timerId = setTimeout(finish, 260);
      return;
    }
    const r = pool[Math.floor(Math.random() * pool.length)];
    textEl.textContent = r.keyword;
    i++;
    const delay = 55 + i * 12; // 점점 느려짐
    timerId = setTimeout(tick, delay);
  }

  activeSpinSkip = finish;
  tick();
}

function judge(result) {
  if (trySkipSpin()) return;
  if (state.study.busy || !state.study.currentId) return;
  const id = state.study.currentId;
  state.study.status[id] = result === "known" ? "known" : "unknown";
  persistStudy();
  animateOut(result, () => pickNextCard(false));
}

function animateOut(result, cb) {
  state.study.busy = true;
  const wrapper = $("#card-wrapper");
  const dir = result === "known" ? 1 : -1;
  wrapper.style.transition = "transform 0.28s ease, opacity 0.28s ease";
  wrapper.style.transform = `translateX(${dir * 420}px) rotate(${dir * 18}deg)`;
  wrapper.style.opacity = "0";
  setTimeout(cb, 240);
}

function showComplete() {
  $("#study-stage").hidden = true;
  $("#roulette-overlay").hidden = true;
  $("#complete-sub").textContent = `"${state.study.name}" 세트의 키워드 ${state.study.keywords.length}개를 모두 외웠어요!`;
  $("#view-complete").hidden = false;
}

/* ---- 카드 조작: 클릭으로 뒤집기, 버튼/키보드/스와이프로 판정 ---- */
let suppressNextClick = false;
// setPointerCapture(아래 스와이프 로직)가 클릭 이벤트의 target을 card-wrapper로
// 재지정하므로, 카드 자체가 아니라 wrapper에 리스너를 둔다.
$("#card-wrapper").addEventListener("click", () => {
  if (trySkipSpin()) return;
  if (state.study.busy || suppressNextClick) {
    suppressNextClick = false;
    return;
  }
  $("#card").classList.toggle("flipped");
});

$("#btn-known").addEventListener("click", () => judge("known"));
$("#btn-unknown").addEventListener("click", () => judge("unknown"));

$("#study-back").addEventListener("click", () => {
  showView("home");
  renderHome();
});

$("#study-reset").addEventListener("click", () => {
  if (!confirm("이 세트의 학습 상태를 전체 초기화할까요? 모든 키워드가 다시 '모른다' 상태가 돼요.")) return;
  state.study.keywords.forEach((k) => (state.study.status[k.id] = "unknown"));
  persistStudy();
  $("#view-complete").hidden = true;
  state.study.lastId = null;
  pickNextCard(true);
  toast("학습 상태를 초기화했어요.");
});

$("#complete-reset").addEventListener("click", () => {
  state.study.keywords.forEach((k) => (state.study.status[k.id] = "unknown"));
  persistStudy();
  $("#view-complete").hidden = true;
  state.study.lastId = null;
  pickNextCard(true);
});
$("#complete-home").addEventListener("click", () => {
  $("#view-complete").hidden = true;
  showView("home");
  renderHome();
});

document.addEventListener("keydown", (e) => {
  if (state.view !== "study") return;
  if ((e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === " " || e.key === "Enter") && trySkipSpin()) {
    e.preventDefault();
    return;
  }
  if (state.study.busy) return;
  if (e.key === "ArrowRight") judge("known");
  else if (e.key === "ArrowLeft") judge("unknown");
  else if (e.key === " " || e.key === "Enter") {
    e.preventDefault();
    $("#card").classList.toggle("flipped");
  }
});

/* ---- 스와이프 (마우스 드래그 + 터치) ---- */
(function setupSwipe() {
  const wrapper = $("#card-wrapper");
  let dragging = false;
  let startX = 0;
  let currentX = 0;
  const THRESHOLD = 90;

  function onDown(x) {
    if (trySkipSpin()) {
      // 이 press로 스핀만 멈추고, 뒤이어 발생하는 click 이벤트가 카드를
      // 뒤집지 않도록 막는다(뒤집기는 스핀이 멈춘 뒤 다시 눌러야 동작).
      suppressNextClick = true;
      return;
    }
    if (state.study.busy) return;
    dragging = true;
    startX = x;
    currentX = x;
    wrapper.style.transition = "none";
  }
  function onMove(x) {
    if (!dragging) return;
    currentX = x;
    const dx = currentX - startX;
    wrapper.style.transform = `translateX(${dx}px) rotate(${dx / 18}deg)`;
    $(".swipe-badge-know").style.opacity = Math.max(0, dx / THRESHOLD);
    $(".swipe-badge-unknown").style.opacity = Math.max(0, -dx / THRESHOLD);
  }
  function onUp() {
    if (!dragging) return;
    dragging = false;
    const dx = currentX - startX;
    if (Math.abs(dx) > 6) suppressNextClick = true;
    $(".swipe-badge-know").style.opacity = 0;
    $(".swipe-badge-unknown").style.opacity = 0;
    wrapper.style.transition = "transform 0.25s ease";
    if (dx > THRESHOLD) {
      judge("known");
    } else if (dx < -THRESHOLD) {
      judge("unknown");
    } else {
      wrapper.style.transform = "translateX(0) rotate(0)";
    }
  }

  wrapper.addEventListener("pointerdown", (e) => {
    wrapper.setPointerCapture(e.pointerId);
    onDown(e.clientX);
  });
  wrapper.addEventListener("pointermove", (e) => onMove(e.clientX));
  wrapper.addEventListener("pointerup", onUp);
  wrapper.addEventListener("pointercancel", onUp);
})();

/* ============================================================
   초기화
   ============================================================ */
// 저장된 세트가 하나도 없는 첫 방문이면, 버튼 클릭 없이 바로 첨부 텍스트로
// 검수 화면까지 진입시킨다. 이미 세트가 있으면(재방문) 홈에서 이어서 고르게 둔다.
if (loadSetsIndex().length === 0) {
  startFromText(SAMPLE_TEXT, DEFAULT_SET_NAME);
} else {
  renderHome();
  showView("home");
}
