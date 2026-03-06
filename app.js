// NumberSense Tutor v3.7
// [v3.7] Setup screen: name, mode/op/max, last-session summary before first problem
// [v3.7] Timer starts on first keystroke, not on problem load
// [v3.7] 1-second pause + input lock after wrong answer before advancing
// [v3.7] Progress indicator: running correct/wrong tally
// [v3.7] Student name stored on session, shown in header, included in CSV
// [v3.6] Spaced repetition: missed problems return within 5 problems, retry until correct
// [v3.6] Session comparison panel: last 5 sessions, accuracy %, attempted, correct, wrong
// [v3.5] Streak celebration at 5, 10, 20 correct in a row
// [v3.5] makeStory expanded to 8 templates per operation (was 3)
// [v3.5] localStorage error boundary — graceful fallback in private/full-storage
// [v3.5] Hint button now shows "(H)" so the keyboard shortcut is discoverable
// [v3.5] Mobile Go/Done key now submits; deprecated execCommand replaced in paste handler
// [v3.4] Adaptive dedup queue — no repeated problems in a short window

const SESSIONS_KEY = 'ns_sessions_v1';

const $ = (id) => document.getElementById(id);

function formatTime(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = seconds.toFixed(2).padStart(5, '0');
  return `${mm}:${ss}`;
}

const sessionOverlay  = $('sessionOverlay');
const continueBtn     = $('continueSessionBtn');
const newBtn          = $('newSessionBtn');
// [v3.7] Setup screen elements
const setupModeSelect  = $('setupModeSelect');
const setupOpSelect    = $('setupOpSelect');
const setupMaxNumber   = $('setupMaxNumber');
const studentNameInput = $('studentNameInput');
const lastSessionSummary = $('lastSessionSummary');
const progressIndicator  = $('progressIndicator');
const appShell        = $('appShell');
const modeSelect      = $('modeSelect');
const opSelect        = $('opSelect');
const maxNumber       = $('maxNumber');
const problemArea     = $('problemArea');
const visualArea      = $('visualArea');
const answerForm      = $('answerForm');
const answerInput     = $('answerInput');
const checkBtn        = $('checkBtn');
const nextBtn         = $('nextBtn');
const resetStatsBtn   = $('resetStats');
const downloadSessionBtn = $('downloadSessionBtn');
const hintBtn         = $('hintBtn');
const hintText        = $('hintText');
const feedback        = $('feedback');
const timerEl         = $('timer');
const statCorrect     = $('statCorrect');
const statAttempted   = $('statAttempted');
const statAvgTime     = $('statAvgTime');
const statStreak      = $('statStreak');
const historyBody     = $('historyBody');

// [v3.5] Make the H shortcut visible on the button itself
hintBtn.textContent = 'Hint (H)';

const state = {
  mode:         'flash',
  op:           'mix',
  max:          20,
  current:      null,
  startTime:    null,
  timerInt:     null,
  hintUsed:     false,
  timerStarted: false  // [v3.7] true once student starts typing for this problem
};

let currentSession = null;

/* -------------------------
   DEDUPLICATION (v3.4)
------------------------- */
const recentProblems = [];

function estimatePoolSize(mode, op, max) {
  if (mode === 'shortcut_make10') {
    let c = 0;
    for (let a = 6; a <= 9; a++)
      for (let b = 1; b <= 9; b++)
        if (a + b > 10 && a + b <= max) c++;
    return Math.max(c, 1);
  }
  if (mode === 'decompose') return Math.max(max - 4, 1);
  if (op === 'mul') {
    let c = 0;
    for (let a = 1; a <= max; a++)
      for (let b = 1; b <= max; b++)
        if (a * b <= max) c++;
    return Math.max(c, 1);
  }
  if (op === 'div') {
    let c = 0;
    const md = Math.min(12, Math.floor(max / 2));
    for (let b = 2; b <= md; b++) c += Math.max(Math.floor(max / b), 0);
    return Math.max(c, 1);
  }
  return Math.max(Math.floor(max * max / 4), 1);
}

function recentLimit(mode, op, max) {
  return Math.max(1, Math.min(8, Math.floor(estimatePoolSize(mode, op, max) / 2)));
}

function isRecentProblem(prob) { return recentProblems.includes(prob.text); }

function recordRecentProblem(prob) {
  recentProblems.push(prob.text);
  while (recentProblems.length > recentLimit(state.mode, state.op, state.max))
    recentProblems.shift();
}


/* -------------------------
   SPACED REPETITION (v3.6)
   Missed problems are stored in missedQueue with a countdown.
   Each entry: { prob, dueAfter }
   - dueAfter counts down by 1 each time a new problem is served.
   - When dueAfter reaches 0 the problem is served next.
   - Answered correctly -> removed from queue.
   - Answered wrong again -> dueAfter reset to MISSED_INTERVAL (retry in 5).
   - Queue is cleared when mode/op/max changes (stale problems).
------------------------- */
const MISSED_INTERVAL = 5;
const missedQueue = [];

function enqueueMissed(prob) {
  // Avoid duplicate entries for the same problem text
  var existing = null;
  for (var i = 0; i < missedQueue.length; i++) {
    if (missedQueue[i].prob.text === prob.text) { existing = missedQueue[i]; break; }
  }
  if (existing) {
    existing.dueAfter = MISSED_INTERVAL; // reset countdown
  } else {
    missedQueue.push({ prob: prob, dueAfter: MISSED_INTERVAL });
  }
}

function tickMissedQueue() {
  for (var i = 0; i < missedQueue.length; i++) {
    if (missedQueue[i].dueAfter > 0) missedQueue[i].dueAfter--;
  }
}

function getDueMissedProblem() {
  for (var i = 0; i < missedQueue.length; i++) {
    if (missedQueue[i].dueAfter === 0) return missedQueue[i].prob;
  }
  return null;
}

function removeMissedProblem(probText) {
  for (var i = missedQueue.length - 1; i >= 0; i--) {
    if (missedQueue[i].prob.text === probText) { missedQueue.splice(i, 1); return; }
  }
}

/* -------------------------
   SESSION MANAGEMENT
------------------------- */
function loadAllSessions() {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (!raw) return [];
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p : [];
  } catch { return []; }
}

function saveAllSessions(all) {
  try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(all)); }
  catch { /* storage full or unavailable - session continues in memory */ }
}

function createNewSession(studentName) {
  return {
    createdAt: Date.now(), lastUsedAt: Date.now(),
    studentName: studentName || '',
    history: [],
    stats: { correct: 0, attempted: 0, times: [], streak: 0 }
  };
}

// [v3.5] Full error boundary around persist
function persistSession() {
  try {
    let all = loadAllSessions();
    if (!all.length) { all = [currentSession]; }
    else { all[all.length - 1] = currentSession; }
    currentSession.lastUsedAt = Date.now();
    saveAllSessions(all);
  } catch { /* non-fatal */ }
}

// [v3.7] Populate setup overlay from last session settings (or defaults)
function initSetupOverlay() {
  const all = loadAllSessions();
  const last = all.length ? all[all.length - 1] : null;

  // Pre-fill settings from last session if available
  if (last) {
    setupModeSelect.value = last.lastMode || 'flash';
    setupOpSelect.value   = last.lastOp   || 'mix';
    setupMaxNumber.value  = last.lastMax  || 20;
    if (last.studentName) studentNameInput.value = last.studentName;

    // Show last session summary
    const s = last.stats || {};
    const attempted = s.attempted || 0;
    const correct   = s.correct   || 0;
    const acc       = attempted > 0 ? Math.round((correct / attempted) * 100) : 0;
    const d         = last.createdAt ? new Date(last.createdAt) : new Date();
    const dateStr   = (d.getMonth()+1) + '/' + d.getDate() + '/' + d.getFullYear();
    lastSessionSummary.style.display = 'block';
    lastSessionSummary.innerHTML =
      '<strong>Last session — ' + dateStr + '</strong>' +
      attempted + ' problems &nbsp;·&nbsp; ' + correct + ' correct' +
      (attempted > 0 ? ' &nbsp;·&nbsp; <b>' + acc + '%</b> accuracy' : '');
  } else {
    // No saved session — hide Continue button, show only New
    continueBtn.style.display = 'none';
  }
}

// Read setup values and apply to state
function applySetupValues() {
  state.mode = setupModeSelect.value;
  state.op   = setupOpSelect.value;
  state.max  = Math.max(5, Math.min(100, parseInt(setupMaxNumber.value, 10) || 20));
}

continueBtn.addEventListener('click', () => {
  applySetupValues();
  const all = loadAllSessions();
  currentSession = all.length ? all[all.length - 1] : createNewSession(studentNameInput.value.trim());
  // Update name and last settings on the existing session
  currentSession.studentName = studentNameInput.value.trim();
  currentSession.lastMode    = state.mode;
  currentSession.lastOp      = state.op;
  currentSession.lastMax     = state.max;
  if (!all.length) persistSession();
  startApp();
});

newBtn.addEventListener('click', () => {
  applySetupValues();
  const all = loadAllSessions();
  currentSession = createNewSession(studentNameInput.value.trim());
  currentSession.lastMode = state.mode;
  currentSession.lastOp   = state.op;
  currentSession.lastMax  = state.max;
  all.push(currentSession);
  saveAllSessions(all);
  startApp();
});

// Run setup overlay init immediately
initSetupOverlay();

/* -------------------------
   APP STARTUP
------------------------- */
function startApp() {
  sessionOverlay.style.display = 'none';
  appShell.setAttribute('aria-hidden', 'false');

  // Sync in-app selects with setup screen choices
  modeSelect.value  = state.mode;
  opSelect.value    = state.op;
  maxNumber.value   = state.max;

  // [v3.7] Show student name in header if provided
  const name = (currentSession && currentSession.studentName) ? currentSession.studentName : '';
  let nameEl = document.getElementById('studentNameDisplay');
  if (!nameEl) {
    nameEl = document.createElement('div');
    nameEl.id = 'studentNameDisplay';
    const header = document.querySelector('header');
    if (header) header.appendChild(nameEl);
  }
  nameEl.textContent = name ? 'Student: ' + name : '';

  wireUI();
  renderStats();
  renderHistoryTable();
  renderSessionComparison();
  renderProgressIndicator();
  newProblem();
}

/* -------------------------
   STREAK CELEBRATION (v3.5)
------------------------- */
const STREAK_MILESTONES = [5, 10, 20];

(function injectStreakStyles() {
  const s = document.createElement('style');
  s.textContent = `
    @keyframes streakFlash {
      0%   { background-color: #ffffff; }
      25%  { background-color: #fef08a; }
      75%  { background-color: #fef08a; }
      100% { background-color: #ffffff; }
    }
    .streak-flash { animation: streakFlash 0.8s ease-out; }
    #streakBanner {
      position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
      background: linear-gradient(135deg, #6366f1, #ec4899);
      color: white; padding: 12px 28px; border-radius: 999px;
      font-family: 'Nunito', sans-serif; font-weight: 800; font-size: 1.1rem;
      box-shadow: 0 8px 20px rgba(99,102,241,0.4);
      z-index: 1000; pointer-events: none; transition: opacity 0.5s ease;
    }
    #streakBanner.fade-out { opacity: 0; }
  `;
  document.head.appendChild(s);
})();

function celebrateStreak(streak) {
  const card = document.querySelector('.card');
  if (card) {
    card.classList.remove('streak-flash');
    void card.offsetWidth;
    card.classList.add('streak-flash');
    setTimeout(() => card.classList.remove('streak-flash'), 900);
  }

  const msgs = {
    5:  'On fire! 5 in a row!',
    10: 'Amazing! 10 streak!',
    20: 'Incredible! 20 in a row!'
  };

  let banner = document.getElementById('streakBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'streakBanner';
    document.body.appendChild(banner);
  }

  // Cancel any in-flight timers from a previous celebration
  clearTimeout(banner._t);
  clearTimeout(banner._hideT);

  // Snap back to visible — disable transition momentarily so it doesn't animate the reset
  banner.style.transition = 'none';
  banner.style.opacity = '1';
  banner.style.display = 'block';
  banner.classList.remove('fade-out');
  banner.textContent = msgs[streak] || `${streak} in a row!`;

  // Re-enable the CSS transition on the next frame
  requestAnimationFrame(() => { banner.style.transition = ''; });

  // After 2.5s start fade, then fully hide once fade completes (0.5s)
  banner._t = setTimeout(() => {
    banner.classList.add('fade-out');
    banner._hideT = setTimeout(() => { banner.style.display = 'none'; }, 500);
  }, 2500);
}

/* -------------------------
   CSV EXPORT
------------------------- */
function downloadSessionCSV() {
  if (!currentSession) { alert('No session loaded.'); return; }
  const rows = currentSession.history || [];
  if (!rows.length) { alert('No attempts in this session yet.'); return; }

  const header = ['StudentName','Problem','StudentAnswer','Correct','TimeSeconds','HintUsed','Timestamp'];
  const clean = (val) => {
    if (val == null) return '';
    const s = String(val);
    return (s.includes(',') || s.includes('"') || s.includes('\n'))
      ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const studentName = (currentSession && currentSession.studentName) ? currentSession.studentName : '';
  const dataRows = rows.map(r => [
    clean(studentName), clean(r.problemText), clean(r.studentAnswer),
    clean(r.correct ? 'Yes' : 'No'), clean(r.timeTaken),
    clean(r.hintUsed ? 'Yes' : 'No'), clean(r.timestamp || '')
  ].join(','));

  const csv  = [header.join(','), ...dataRows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const d    = currentSession.createdAt ? new Date(currentSession.createdAt) : new Date();
  const name = 'numbersense_session_' + d.getFullYear() + '-' +
    String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0') + '.csv';
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/* -------------------------
   PROBLEM GENERATION
------------------------- */
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateProblem(mode, op, max) {
  if (mode === 'shortcut_make10') {
    const cands = [];
    for (let a = 6; a <= 9; a++)
      for (let b = 1; b <= 9; b++)
        if (a + b > 10 && a + b <= max) cands.push({ a, b });
    if (!cands.length) return generateProblem('flash', op, max);
    const pair = cands[randInt(0, cands.length - 1)];
    const a = pair.a, b = pair.b;
    return { type:'arith', a, b, op:'+', answer:a+b, shortcut:'make10',
             text: a + ' + ' + b + ' = ?', hint:make10Hint(a, b) };
  }

  if (mode === 'decompose') {
    const n = randInt(5, Math.max(6, max));
    return { type:'decompose', n,
             text: 'Split ' + n + ' into two whole-number parts.',
             hint: 'Find two whole numbers that add to ' + n + '. Start small and build up.' };
  }

  let fullop = op;
  if (op === 'mix') fullop = Math.random() < 0.5 ? 'add' : 'sub';

  if (fullop === 'div') {
    const maxDiv   = Math.min(12, Math.floor(max / 2));
    const b        = randInt(2, Math.max(2, maxDiv));
    const quotient = randInt(1, Math.max(1, Math.floor(max / b)));
    const dividend = b * quotient;
    return { type:'arith', a:dividend, b:b, op:'/', answer:quotient,
             text: dividend + ' ÷ ' + b + ' = ?', hint:getHint({a:dividend, b:b, op:'/'}) };
  }

  if (fullop === 'mul') {
    const cands = [];
    for (let a = 1; a <= max; a++)
      for (let b = 1; b <= max; b++)
        if (a * b <= max) cands.push({ a:a, b:b, prod:a*b });
    if (!cands.length) {
      const a = randInt(1, max-1), b = randInt(1, Math.max(1, max-a));
      return { type:'arith', a:a, b:b, op:'+', answer:a+b,
               text: a + ' + ' + b + ' = ?', hint:getHint({a:a,b:b,op:'+'}) };
    }
    const c = cands[randInt(0, cands.length-1)];
    return { type:'arith', a:c.a, b:c.b, op:'×', answer:c.prod,
             text: c.a + ' × ' + c.b + ' = ?', hint:getHint({a:c.a, b:c.b, op:'×'}) };
  }

  if (fullop === 'add') {
    const a = randInt(1, max-1), b = randInt(1, Math.max(1, max-a));
    return { type:'arith', a:a, b:b, op:'+', answer:a+b,
             text: a + ' + ' + b + ' = ?', hint:getHint({a:a,b:b,op:'+'}) };
  }
  const a = randInt(2, max), b = randInt(1, a-1);
  return { type:'arith', a:a, b:b, op:'-', answer:a-b,
           text: a + ' - ' + b + ' = ?', hint:getHint({a:a,b:b,op:'-'}) };
}

function make10Hint(a, b) {
  const need = 10 - a, leftover = b - need;
  if (need > 0 && leftover >= 0)
    return a + ' needs ' + need + ' to make 10. Take ' + need + ' from ' + b +
           ', leaving ' + leftover + '. Now think 10 + ' + leftover + '.';
  return 'Move enough from the second number to the first to build 10, then add what is left.';
}

function getHint(p) {
  var a = p.a, b = p.b, op = p.op;
  if (op === '/') return 'Think: what times ' + b + ' equals ' + a + '? ( ? x ' + b + ' = ' + a + ' )';

  if (op === '×') {
    if (a <= 10 && b <= 10)
      return 'Think of ' + a + ' groups of ' + b + '. Picture ' + a + ' rows and ' + b + ' columns.';
    var big = Math.max(a,b), small = Math.min(a,b);
    if (small <= 5) return 'Repeated addition: start with ' + big + ', add it ' + small + ' times.';
    var half = Math.floor(b/2);
    return 'Break it up: (' + a + ' × ' + half + ') + (' + a + ' × ' + (b-half) + ').';
  }

  if (op === '-') {
    if (a <= 10 && b < a) return 'Start at ' + a + '. Count back ' + b + ' steps.';
    if (b >= 10 && b < a) {
      var extra = b - 10;
      return extra > 0 ? 'Take away 10 first, then ' + extra + ' more.'
                       : 'Take away 10. How many are left?';
    }
    if (a > 10 && b < a) {
      var tens = Math.floor(a/10)*10, dist = a - tens, still = b - dist;
      if (dist >= b) return a + ' is ' + tens + ' and ' + dist + '. Take ' + b + ' from the ' + dist + ', then add back ' + tens + '.';
      if (still > 0 && tens - still >= 0)
        return 'Go from ' + a + ' down to ' + tens + ' (uses ' + dist + '), then take ' + still + ' more from ' + tens + '.';
    }
    return 'You have ' + a + '. Take away ' + b + '. How many are left?';
  }

  if (a === b) return 'Double ' + a + ' - count it two times.';
  var bigger = Math.max(a,b), smaller = Math.min(a,b);
  if (a <= 10 && b <= 10) {
    if (a + b > 10) return 'Make 10 first, then add the rest.';
    return 'Start at ' + bigger + '. Count up ' + smaller + ' more.';
  }
  var next10 = Math.ceil(bigger/10)*10, toNext = next10 - bigger;
  if (toNext > 0 && toNext < smaller)
    return 'Use part of ' + smaller + ' to reach ' + next10 + ', then add what is left.';
  return 'Add the smaller number onto the bigger number.';
}

/* -------------------------
   STORY PROBLEMS (v3.5 - 8 templates per operation)
------------------------- */
function makeStory(cur) {
  var a = cur.a, b = cur.b, op = cur.op;
  var t = {
    '+': [
      function() { return 'You have ' + a + ' toy cars and your friend gives you ' + b + ' more. How many now?'; },
      function() { return 'There are ' + a + ' apples in a basket. You pick ' + b + ' more. How many altogether?'; },
      function() { return 'A class reads ' + a + ' pages Monday and ' + b + ' pages Tuesday. How many total?'; },
      function() { return 'You scored ' + a + ' points in round one and ' + b + ' in round two. Total score?'; },
      function() { return 'There are ' + a + ' red fish and ' + b + ' blue fish. How many fish altogether?'; },
      function() { return 'A baker makes ' + a + ' muffins in the morning and ' + b + ' in the afternoon. How many total?'; },
      function() { return 'You collect ' + a + ' stamps Monday and ' + b + ' on Friday. How many stamps?'; },
      function() { return 'A garden has ' + a + ' roses and ' + b + ' sunflowers. How many flowers?'; }
    ],
    '-': [
      function() { return 'You had ' + a + ' stickers and gave away ' + b + '. How many are left?'; },
      function() { return 'You collected ' + a + ' shells but lost ' + b + '. How many remain?'; },
      function() { return 'A baker made ' + a + ' cupcakes and sold ' + b + '. How many are left?'; },
      function() { return 'There were ' + a + ' birds on a wire. ' + b + ' flew away. How many remain?'; },
      function() { return 'You had ' + a + ' crayons but ' + b + ' broke. How many unbroken?'; },
      function() { return 'A library had ' + a + ' books on the shelf. ' + b + ' were checked out. How many remain?'; },
      function() { return 'You saved ' + a + ' coins and spent ' + b + '. How many left?'; },
      function() { return a + ' children were on the playground. ' + b + ' went inside. How many stayed?'; }
    ],
    '×': [
      function() { return 'You have ' + a + ' boxes with ' + b + ' toy cars each. How many cars?'; },
      function() { return 'There are ' + a + ' rows of chairs with ' + b + ' in each row. How many chairs?'; },
      function() { return 'A gardener plants ' + a + ' rows with ' + b + ' flowers each. How many flowers?'; },
      function() { return 'You have ' + a + ' bags each holding ' + b + ' apples. How many apples?'; },
      function() { return 'A bookshelf has ' + a + ' shelves with ' + b + ' books each. How many books?'; },
      function() { return a + ' children each brought ' + b + ' stickers. How many stickers altogether?'; },
      function() { return 'A spider has ' + b + ' legs. How many legs do ' + a + ' spiders have?'; },
      function() { return 'You walk ' + b + ' km every day. How many km in ' + a + ' days?'; }
    ],
    '/': [
      function() { return 'You have ' + a + ' toy cars to share among ' + b + ' friends. How many each?'; },
      function() { return 'A baker has ' + a + ' apples, packing ' + b + ' per box. How many boxes?'; },
      function() { return 'A class of ' + a + ' splits into groups of ' + b + '. How many groups?'; },
      function() { return a + ' stickers go equally onto ' + b + ' pages. How many per page?'; },
      function() { return a + ' cookies shared among ' + b + ' children. How many each?'; },
      function() { return 'A farmer packs ' + b + ' eggs per carton. How many cartons for ' + a + ' eggs?'; },
      function() { return 'You have ' + a + ' minutes split into ' + b + ' equal activities. How many minutes each?'; },
      function() { return a + ' books packed into boxes of ' + b + '. How many boxes?'; }
    ]
  };
  var list = t[op] || t['+'];
  return list[Math.floor(Math.random() * list.length)]();
}


/* -------------------------
   SESSION COMPARISON (v3.6)
   Reads all saved sessions from localStorage and renders a compact
   summary table of the last 5 sessions below the history table.
   Columns: Date, Attempted, Correct, Wrong, Accuracy %
------------------------- */

(function injectSessionPanelStyles() {
  var s = document.createElement('style');
  s.textContent = [
    '.session-comparison { margin-top: 24px; }',
    '.session-comparison summary {',
    '  cursor: pointer; font-weight: 700; font-size: 0.95rem;',
    '  color: #6366f1; user-select: none; padding: 4px 0;',
    '  list-style: none; display: flex; align-items: center; gap: 6px;',
    '}',
    '.session-comparison summary::-webkit-details-marker { display: none; }',
    '.session-comparison summary::before { content: "▶"; font-size: 0.7rem; transition: transform 0.2s; }',
    '.session-comparison[open] summary::before { transform: rotate(90deg); }',
    '.session-comparison-table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 0.88rem; }',
    '.session-comparison-table th { text-align: left; padding: 5px 8px;',
    '  border-bottom: 2px solid #e5e7eb; color: #6b7280; font-weight: 600; }',
    '.session-comparison-table td { padding: 5px 8px; border-bottom: 1px solid #f3f4f6; }',
    '.session-comparison-table tr:last-child td { border-bottom: none; }',
    '.session-comparison-table tr.current-session td { font-weight: 700; color: #6366f1; }',
    '.acc-high { color: #16a34a; font-weight: 700; }',
    '.acc-mid  { color: #d97706; font-weight: 700; }',
    '.acc-low  { color: #dc2626; font-weight: 700; }'
  ].join('\n');
  document.head.appendChild(s);
})();

function renderSessionComparison() {
  // Remove existing panel so we always render fresh
  var existing = document.getElementById('sessionComparisonPanel');
  if (existing) existing.remove();

  var all = loadAllSessions();
  if (all.length < 1) return; // nothing to compare yet

  // Take the last 5 sessions (most recent last in array)
  var recent = all.slice(-5).reverse(); // most recent first

  var details = document.createElement('details');
  details.id = 'sessionComparisonPanel';
  details.className = 'session-comparison';

  var summary = document.createElement('summary');
  summary.textContent = 'Session History (last ' + recent.length + ')';
  details.appendChild(summary);

  var table = document.createElement('table');
  table.className = 'session-comparison-table';

  // Header
  var thead = document.createElement('thead');
  thead.innerHTML = '<tr>' +
    '<th>Date</th>' +
    '<th>Attempted</th>' +
    '<th>Correct</th>' +
    '<th>Wrong</th>' +
    '<th>Accuracy</th>' +
    '</tr>';
  table.appendChild(thead);

  var tbody = document.createElement('tbody');
  for (var i = 0; i < recent.length; i++) {
    var sess = recent[i];
    var stats = sess.stats || {};
    var attempted = stats.attempted || 0;
    var correct   = stats.correct   || 0;
    var wrong     = attempted - correct;
    var acc       = attempted > 0 ? Math.round((correct / attempted) * 100) : 0;
    var accClass  = acc >= 80 ? 'acc-high' : acc >= 60 ? 'acc-mid' : 'acc-low';

    var d = sess.createdAt ? new Date(sess.createdAt) : new Date(0);
    var dateStr = (d.getMonth() + 1) + '/' + d.getDate() + '/' + String(d.getFullYear()).slice(-2);

    var tr = document.createElement('tr');
    // Highlight the current session
    if (sess === currentSession || (currentSession && sess.createdAt === currentSession.createdAt)) {
      tr.className = 'current-session';
      dateStr += ' ★';
    }

    tr.innerHTML = '<td>' + dateStr + '</td>' +
      '<td>' + attempted + '</td>' +
      '<td>' + correct + '</td>' +
      '<td>' + wrong + '</td>' +
      '<td class="' + accClass + '">' + (attempted > 0 ? acc + '%' : '—') + '</td>';
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  details.appendChild(table);

  // Insert after the history-wrap div
  var histWrap = historyBody.closest('.history-wrap') || historyBody.parentNode;
  histWrap.parentNode.insertBefore(details, histWrap.nextSibling);
}

/* -------------------------
   PROGRESS INDICATOR (v3.7)
   Shows running correct / wrong tally for the current session.
------------------------- */
function renderProgressIndicator() {
  if (!currentSession || !progressIndicator) return;
  const correct  = currentSession.stats.correct   || 0;
  const attempted = currentSession.stats.attempted || 0;
  const wrong    = attempted - correct;

  if (attempted === 0) {
    progressIndicator.innerHTML = '';
    return;
  }

  progressIndicator.innerHTML =
    '<span class="pi-correct">' + correct + ' ✓</span>' +
    '<span class="pi-wrong">'   + wrong   + ' ✗</span>';
}

/* -------------------------
   RENDER / NEW PROBLEM
------------------------- */
function newProblem() {
  var cur;

  // [v3.6] Spaced repetition: serve a due missed problem first if one is ready
  var dueMissed = getDueMissedProblem();
  if (dueMissed) {
    cur = Object.assign({}, dueMissed, { _isRetry: true });
  } else {
    // Tick the missed queue countdown whenever a fresh problem is served
    tickMissedQueue();
    for (var i = 0; i < 15; i++) {
      cur = generateProblem(state.mode, state.op, state.max);
      if (!isRecentProblem(cur)) break;
    }
    recordRecentProblem(cur);
  }

  state.current   = cur;
  state.startTime = Date.now();
  state.hintUsed  = false;

  feedback.textContent = '';
  hintText.textContent = '';
  visualArea.innerHTML = '';

  // [v3.6] Show a subtle retry label if this is a spaced-repetition revisit
  var retryLabel = document.getElementById('retryLabel');
  if (!retryLabel) {
    retryLabel = document.createElement('div');
    retryLabel.id = 'retryLabel';
    retryLabel.style.cssText = 'font-size:0.78rem;color:#f59e0b;font-weight:700;' +
      'letter-spacing:0.05em;text-transform:uppercase;margin-bottom:4px;min-height:1.1em;';
    problemArea.parentNode.insertBefore(retryLabel, problemArea);
  }
  retryLabel.textContent = cur._isRetry ? "↩ Let's try this one again" : '';

  problemArea.textContent = (state.mode === 'word' && cur.type === 'arith')
    ? makeStory(cur) : cur.text;

  if (state.mode === 'visual' && (cur.type === 'arith' || cur.type === 'decompose')) {
    renderVisual(cur);
  } else if (state.mode === 'shortcut_make10' && cur.type === 'arith') {
    renderMake10Visual(cur);
  }

  configureAnswerFieldForMode();
  answerInput.value = '';
  answerInput.disabled = false;
  answerInput.focus();

  // [v3.7] Timer starts on first keystroke — show idle state until then
  stopTimer();
  state.timerStarted = false;
  timerEl.textContent = 'Time: —';
}

function renderVisual(cur) {
  var n;
  if (cur.type === 'arith') {
    n = (cur.op === '+') ? cur.a + cur.b : (cur.op === '×') ? cur.a * cur.b : cur.a;
  } else { n = cur.n; }

  var container = document.createElement('div');
  container.className = 'card';
  container.setAttribute('aria-label', 'ten-frames');

  if (cur.op === '/') {
    var cap = document.createElement('div');
    cap.className = 'hint';
    cap.style.marginBottom = '8px';
    cap.textContent = 'Total: ' + n + '. Split into groups of ' + cur.b + '.';
    container.appendChild(cap);
  }

  for (var f = 0; f < Math.ceil(n / 10); f++) {
    var frame = document.createElement('div');
    frame.className = 'tenframe';
    for (var i = 1; i <= 10; i++) {
      var cell = document.createElement('div');
      cell.className = 'cell';
      if (f * 10 + i <= n) cell.classList.add('filled');
      frame.appendChild(cell);
    }
    container.appendChild(frame);
  }

  if (cur.type === 'arith' && cur.op === '-') {
    var filled = container.querySelectorAll('.cell.filled');
    for (var i = filled.length - 1, rem = cur.b; rem > 0 && i >= 0; i--, rem--) {
      filled[i].classList.add('crossed');
      filled[i].classList.remove('filled');
    }
  }
  visualArea.appendChild(container);
}

function renderMake10Visual(cur) {
  var a = cur.a, b = cur.b;
  var container = document.createElement('div');
  container.className = 'card';
  container.setAttribute('aria-label', 'make-10 visual');

  var title = document.createElement('div');
  title.textContent = 'Make 10 by moving dots:';
  title.style.cssText = 'font-size:14px;margin-bottom:4px;';
  container.appendChild(title);

  var row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:16px;flex-wrap:wrap;';

  function makeFrame(filled) {
    var frame = document.createElement('div');
    frame.className = 'tenframe';
    for (var i = 1; i <= 10; i++) {
      var cell = document.createElement('div');
      cell.className = 'cell';
      if (i <= filled) cell.classList.add('filled');
      frame.appendChild(cell);
    }
    return frame;
  }
  row.appendChild(makeFrame(a));
  row.appendChild(makeFrame(b));
  container.appendChild(row);

  var need = 10 - a, leftover = b - need;
  var expl = document.createElement('div');
  expl.className = 'hint';
  expl.textContent = (need > 0 && leftover >= 0)
    ? a + ' needs ' + need + ' to make 10. Slide ' + need + ' dots across. Then you have 10 and ' + leftover + '.'
    : 'Use the first frame to build 10, then see what is left in the second.';
  container.appendChild(expl);
  visualArea.appendChild(container);
}

/* -------------------------
   ANSWER CHECKING
------------------------- */
function parseDecompose(raw) {
  var m = raw.match(/(\d+)\s*(?:[,+\s])\s*(\d+)/);
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : null;
}

function allDecomposePairs(n) {
  var p = [];
  for (var a = 1; a <= Math.floor(n / 2); a++) p.push(a + '+' + (n - a));
  return p;
}

function checkAnswerAndAdvance() {
  if (!state.current) return;
  stopTimer();

  // [v3.7] If the student never typed (submitted blank via Enter), use 0s elapsed
  var totalSeconds = state.timerStarted ? (Date.now() - state.startTime) / 1000 : 0;
  var timeDisplay  = state.timerStarted ? formatTime(totalSeconds) : '—';
  var cur = state.current;
  var raw = answerInput.value.trim();

  if (!raw) {
    feedback.textContent = 'Please type an answer first.';
    // Restart timer only if it was already going
    if (state.timerStarted) startTimer();
    return;
  }

  var correct = false, correctAnswer = null;

  if (cur.type === 'decompose') {
    var parts = parseDecompose(raw);
    if (!parts) {
      feedback.textContent = 'Format example: 3+7 or 3,7';
      if (state.timerStarted) startTimer();
      return;
    }
    correct = (parts[0] + parts[1] === cur.n);
  } else {
    var num = Number(raw);
    if (!Number.isFinite(num)) {
      feedback.textContent = 'Please enter a number.';
      if (state.timerStarted) startTimer();
      return;
    }
    correct = (num === cur.answer);
    correctAnswer = cur.answer;
  }

  if (correct) {
    if (cur.type === 'decompose') {
      var pairs = allDecomposePairs(cur.n).join(' - ');
      feedback.innerHTML = 'Correct! All ways to make ' + cur.n + ': <span style="font-weight:600">' + pairs + '</span>' + (state.timerStarted ? ' (took ' + timeDisplay + ')' : '');
    } else {
      feedback.textContent = 'Correct! ' + problemTextForHistory(cur) + ' = ' + correctAnswer + (state.timerStarted ? ' (took ' + timeDisplay + ')' : '');
    }
  } else {
    feedback.textContent = cur.type === 'decompose'
      ? 'Not quite — try another way to split ' + cur.n + '.'
      : 'Not quite — the answer is ' + correctAnswer + '.';
  }

  currentSession.stats.attempted++;
  if (state.timerStarted) currentSession.stats.times.push(totalSeconds);
  if (correct) {
    currentSession.stats.correct++;
    currentSession.stats.streak = (currentSession.stats.streak || 0) + 1;
    if (STREAK_MILESTONES.indexOf(currentSession.stats.streak) !== -1) {
      celebrateStreak(currentSession.stats.streak);
    }
    // [v3.6] Correct answer — remove from missed queue if it was a retry
    removeMissedProblem(cur.text);
  } else {
    currentSession.stats.streak = 0;
    // [v3.6] Wrong answer — add/reset in missed queue so it returns within 5 problems
    enqueueMissed(cur);
  }

  currentSession.history.push({
    problemText:   displayTextForHistory(cur),
    studentAnswer: raw, correct: correct,
    timeTaken:     timeDisplay,
    hintUsed:      state.hintUsed,
    timestamp:     new Date().toISOString()
  });

  // Save current mode/op/max so next session can restore them
  currentSession.lastMode = state.mode;
  currentSession.lastOp   = state.op;
  currentSession.lastMax  = state.max;

  persistSession();
  renderStats();
  renderHistoryTable();
  renderSessionComparison();
  renderProgressIndicator();

  if (correct) {
    // Advance immediately on correct
    newProblem();
  } else {
    // [v3.7] 1-second pause on wrong answer — lock input so student reads the feedback
    answerInput.disabled = true;
    setTimeout(function() {
      answerInput.disabled = false;
      newProblem();
    }, 1000);
  }
}

function displayTextForHistory(cur) {
  return (state.mode === 'word' && cur.type === 'arith') ? makeStory(cur) : cur.text;
}
function problemTextForHistory(cur) {
  return cur.type === 'arith' ? cur.a + ' ' + cur.op + ' ' + cur.b : cur.text;
}

/* -------------------------
   STATS + HISTORY UI
------------------------- */
function averageTime(times) {
  if (!times.length) return 0;
  return Math.round(times.reduce(function(a, b) { return a + b; }, 0) / times.length);
}

function renderStats() {
  statCorrect.textContent   = currentSession.stats.correct   || 0;
  statAttempted.textContent = currentSession.stats.attempted || 0;
  statAvgTime.textContent   = averageTime(currentSession.stats.times);
  statStreak.textContent    = currentSession.stats.streak    || 0;
}

function renderHistoryTable() {
  historyBody.innerHTML = '';
  var rows = currentSession.history.slice().reverse();
  for (var i = 0; i < rows.length; i++) {
    var item = rows[i];
    var tr = document.createElement('tr');
    tr.className = item.correct ? 'correct' : 'wrong';
    var cells = [item.problemText, item.studentAnswer,
                 item.correct ? 'Yes':'No', item.timeTaken,
                 item.hintUsed ? 'Yes':'No'];
    for (var j = 0; j < cells.length; j++) {
      var td = document.createElement('td');
      td.textContent = cells[j];
      tr.appendChild(td);
    }
    historyBody.appendChild(tr);
  }
}

/* -------------------------
   HINTS
------------------------- */
function showHint() {
  var cur = state.current;
  if (!cur) return;
  state.hintUsed = true;
  if (cur.type === 'decompose') {
    hintText.textContent = cur.hint || 'Think of two numbers that add to ' + cur.n + '.';
  } else if (cur.type === 'arith') {
    hintText.textContent = cur.hint || 'Use what you know about tens to solve it.';
  } else {
    hintText.textContent = 'Think carefully about what the story is asking.';
  }
}

/* -------------------------
   INPUT / TIMING
------------------------- */
function configureAnswerFieldForMode() {
  if (state.current && state.current.type === 'decompose') {
    answerInput.setAttribute('type', 'text');
    answerInput.setAttribute('inputmode', 'numeric');
    answerInput.setAttribute('pattern', '[0-9, +]*');
    answerInput.removeAttribute('step');
    answerInput.placeholder = 'Type two whole numbers, like 2+3';
  } else {
    answerInput.setAttribute('type', 'number');
    answerInput.setAttribute('inputmode', 'numeric');
    answerInput.setAttribute('pattern', '[0-9]*');
    answerInput.setAttribute('step', '1');
    answerInput.placeholder = 'Type answer';
  }
}

// [v3.5] Paste handler - replaces deprecated execCommand
answerInput.addEventListener('paste', function(e) {
  e.preventDefault();
  var text    = (e.clipboardData || window.clipboardData).getData('text') || '';
  var cleaned = (state.current && state.current.type === 'decompose')
    ? text.replace(/[^0-9,+ ]/g, '') : text.replace(/[^0-9]/g, '');
  var s = answerInput.selectionStart, en = answerInput.selectionEnd;
  answerInput.value = answerInput.value.slice(0, s) + cleaned + answerInput.value.slice(en);
  answerInput.selectionStart = answerInput.selectionEnd = s + cleaned.length;
});


// [v3.7] Start timer on first keystroke — not on problem load
answerInput.addEventListener('input', function() {
  if (!state.timerStarted && state.current) {
    state.timerStarted = true;
    startTimer();
  }
});

// [v3.5] Enter key fix covers mobile Go/Done key
answerInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    checkAnswerAndAdvance();
    return;
  }
  if ((e.key === 'n' || e.key === 'N') && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault(); newProblem(); return;
  }
  var nav = ['Backspace','Delete','ArrowLeft','ArrowRight','Tab','Home','End'];
  if (nav.indexOf(e.key) !== -1 || e.ctrlKey || e.metaKey) return;
  var ok = (state.current && state.current.type === 'decompose')
    ? /[0-9,+ ]/.test(e.key) : /[0-9]/.test(e.key);
  if (!ok) e.preventDefault();
});

function globalKeydown(e) {
  if (e.target === answerInput) return;
  if (e.key.toLowerCase() === 'n') newProblem();
  if (e.key.toLowerCase() === 'h') showHint();
}

function startTimer() {
  stopTimer();
  timerEl.textContent = 'Time: 0s';
  state.startTime = Date.now();
  state.timerInt  = setInterval(function() {
    timerEl.textContent = 'Time: ' + Math.round((Date.now() - state.startTime) / 1000) + 's';
  }, 300);
}
function stopTimer() {
  if (state.timerInt) { clearInterval(state.timerInt); state.timerInt = null; }
}

/* -------------------------
   WIRE UI
------------------------- */
function wireUI() {
  if (wireUI._wired) return;
  wireUI._wired = true;

  answerForm.addEventListener('submit', function(e) { e.preventDefault(); checkAnswerAndAdvance(); });
  nextBtn.addEventListener('click', function() { newProblem(); });
  hintBtn.addEventListener('click', function() { showHint(); });
  downloadSessionBtn.addEventListener('click', function() { downloadSessionCSV(); });

  resetStatsBtn.addEventListener('click', function() {
    if (confirm('This will erase all saved sessions and progress. Are you sure?')) {
      try { localStorage.removeItem(SESSIONS_KEY); } catch(e) { /* ignore */ }
      currentSession = createNewSession();
      recentProblems.length = 0; missedQueue.length = 0;
      persistSession();
      renderStats();
      renderHistoryTable();
      newProblem();
    }
  });

  document.addEventListener('keydown', globalKeydown);

  modeSelect.addEventListener('change', function(e) {
    state.mode = e.target.value; if (currentSession) currentSession.lastMode = state.mode; recentProblems.length = 0; missedQueue.length = 0; newProblem();
  });
  opSelect.addEventListener('change', function(e) {
    state.op = e.target.value; if (currentSession) currentSession.lastOp = state.op; recentProblems.length = 0; missedQueue.length = 0; newProblem();
  });
  maxNumber.addEventListener('change', function(e) {
    var v = parseInt(e.target.value, 10);
    if (!Number.isFinite(v)) v = 20;
    v = Math.max(5, Math.min(100, v));
    state.max = v; maxNumber.value = v;
    if (currentSession) currentSession.lastMax = state.max;
    recentProblems.length = 0; missedQueue.length = 0; newProblem();
  });
}