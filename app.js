// NumberSense Tutor v3.2
// Fixes:
// - Added Division support to generateProblem, getHint, makeStory, and problemTextForHistory
// - Division ensures dividends do not exceed Max Number
// - UI wiring for buttons and keyboard is set up after session start

const SESSIONS_KEY = 'ns_sessions_v1';

// DOM helpers
const $ = (id)=>document.getElementById(id);

// Format time in seconds as mm:ss.ss (minutes:seconds with hundredths)
function formatTime(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;

  const mm = String(minutes).padStart(2, '0');
  const ss = seconds.toFixed(2).padStart(5, '0'); // e.g. "00:05.23"

  return `${mm}:${ss}`;
}

// Elements
const sessionOverlay   = $('sessionOverlay');
const continueBtn      = $('continueSessionBtn');
const newBtn           = $('newSessionBtn');

const appShell         = $('appShell');

const modeSelect       = $('modeSelect');
const opSelect         = $('opSelect');
const maxNumber        = $('maxNumber');

const problemArea      = $('problemArea');
const visualArea       = $('visualArea');

const answerForm       = $('answerForm');
const answerInput      = $('answerInput');
const checkBtn         = $('checkBtn');

const nextBtn             = $('nextBtn');
const resetStatsBtn       = $('resetStats');
const downloadSessionBtn  = $('downloadSessionBtn');

const hintBtn          = $('hintBtn');
const hintText         = $('hintText');
const feedback         = $('feedback');
const timerEl          = $('timer');

const statCorrect      = $('statCorrect');
const statAttempted    = $('statAttempted');
const statAvgTime      = $('statAvgTime');
const statStreak       = $('statStreak');

const historyBody      = $('historyBody');

// runtime state
const state = {
  mode:       'flash',        // 'flash' | 'visual' | 'word' | 'decompose'
  op:         'mix',          // 'add' | 'sub' | 'mix' | 'div' | 'mul'
  max:        20,
  current:    null,           // current problem object
  startTime:  null,
  timerInt:   null,
  hintUsed:   false
};

// current session object
let currentSession = null;

/* -------------------------
   SESSION MANAGEMENT
------------------------- */

function loadAllSessions(){
  const raw = localStorage.getItem(SESSIONS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveAllSessions(all){
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(all));
}

function createNewSession(){
  return {
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    history: [],
    stats: {
      correct:0,
      attempted:0,
      times:[],
      streak:0
    }
  };
}

function persistSession(){
  let all = loadAllSessions();
  if (!all.length){
    all = [currentSession];
  } else {
    all[all.length-1] = currentSession;
  }
  currentSession.lastUsedAt = Date.now();
  saveAllSessions(all);
}

// Session choice buttons
continueBtn.addEventListener('click', () => {
  const all = loadAllSessions();
  if (!all.length){
    currentSession = createNewSession();
    persistSession();
  } else {
    currentSession = all[all.length-1];
  }
  startApp();
});

newBtn.addEventListener('click', () => {
  const all = loadAllSessions();
  currentSession = createNewSession();
  all.push(currentSession);
  saveAllSessions(all);
  startApp();
});

/* -------------------------
   APP STARTUP
------------------------- */

function startApp(){
  // hide overlay, show app shell
  sessionOverlay.style.display = 'none';
  appShell.setAttribute('aria-hidden','false');

  // sync UI controls from our current state defaults
  modeSelect.value = state.mode;
  opSelect.value   = state.op;
  maxNumber.value  = state.max;

  // wire all UI events now that DOM is "live"
  wireUI();

  // show stats / history from session
  renderStats();
  renderHistoryTable();

  // get first problem
  newProblem();
}

/* -------------------------
   CSV EXPORT
------------------------- */

// Turn currentSession.history into a CSV string and trigger a download
function downloadSessionCSV() {
  if (!currentSession) {
    alert('No session loaded.');
    return;
  }

  const rows = currentSession.history || [];
  if (!rows.length) {
    alert('No attempts in this session yet.');
    return;
  }

  // CSV header
  const header = [
    'Problem',
    'StudentAnswer',
    'Correct',
    'TimeSeconds',
    'HintUsed',
    'Timestamp'
  ];

  const dataRows = rows.map(item => {
    const clean = (val) => {
      if (val === null || val === undefined) return '';
      const str = String(val);
      // wrap in quotes if it contains comma, quote, or newline
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    return [
      clean(item.problemText),
      clean(item.studentAnswer),
      clean(item.correct ? 'Yes' : 'No'),
      clean(item.timeTaken),
      clean(item.hintUsed ? 'Yes' : 'No'),
      clean(item.timestamp || '')   // per-attempt timestamp
    ].join(',');
  });

  const csvString = [header.join(','), ...dataRows].join('\n');

  const blob = new Blob([csvString], { type: 'text/csv' });

  // Name file with session start date (createdAt) if available
  const sessionDate = currentSession.createdAt
    ? new Date(currentSession.createdAt)
    : new Date();
  const yyyy = sessionDate.getFullYear();
  const mm = String(sessionDate.getMonth()+1).padStart(2,'0');
  const dd = String(sessionDate.getDate()).padStart(2,'0');
  const fileName = `numbersense_session_${yyyy}-${mm}-${dd}.csv`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* -------------------------
   PROBLEM GENERATION
------------------------- */

function randInt(min,max){
  return Math.floor(Math.random()*(max-min+1))+min;
}

// Builds one new math/decompose problem object
function generateProblem(mode, op, max){
  // Math Shortcut: Make 10 (addition only)
  if (mode === 'shortcut_make10') {
    const candidates = [];
    for (let a = 6; a <= 9; a++) {
      for (let b = 1; b <= 9; b++) {
        const sum = a + b;
        if (sum > 10 && sum <= max) {
          candidates.push({ a, b });
        }
      }
    }

    if (!candidates.length) {
      return generateProblem('flash', op, max);
    }

    const pair = candidates[randInt(0, candidates.length - 1)];
    const a = pair.a;
    const b = pair.b;
    const answer = a + b;

    return {
      type: 'arith',
      a,
      b,
      op: '+',
      answer,
      shortcut: 'make10',
      text: `${a} + ${b} = ?`,
      hint: make10Hint(a, b)
    };
  }

  // Decompose mode: split N into parts
  if (mode === 'decompose'){
    const n = randInt(5, Math.max(6, max));
    const a = randInt(1, n-1);
    const b = n - a;
    return {
      type:'decompose',
      n,
      text: `Split ${n} into two whole-number parts.`,
      hint:`Find two whole numbers that add to ${n}. Start small and build up.`
    };
  }

  // Determine actual operation for this problem
  let fullop = op;
  if (op === 'mix') {
    fullop = (Math.random() < 0.5 ? 'add' : 'sub');
  }

  if (fullop === 'div') {
    // DIVISION GENERATION
    // Logic: Answer (quotient) * Divisor = Dividend (a)
    // We want 'a' <= max.
    // Divisor 'b' should be at least 2.
    
    // Pick divisor 'b' first.
    // To ensure meaningful problems, limit divisor to typical table range (2-12) 
    // or smaller if 'max' is small.
    const maxDivisor = Math.min(12, Math.floor(max / 2));
    const b = randInt(2, Math.max(2, maxDivisor));
    
    // Pick quotient 'q' such that q * b <= max.
    const maxQ = Math.floor(max / b);
    // If maxQ < 1, we can't make a problem (shouldn't happen if max >= 5)
    const quotient = randInt(1, Math.max(1, maxQ));
    
    const dividend = b * quotient; // This is 'a'

    return {
      type: 'arith',
      a: dividend,
      b: b,
      op: '/',
      answer: quotient,
      text: `${dividend} ÷ ${b} = ?`,
      hint: getHint({ a: dividend, b: b, op: '/' })
    };
  }

  if (fullop === 'mul') {
    // MULTIPLICATION GENERATION
    // We will choose factors a and b such that a * b <= max.
    const candidates = [];
    for (let a = 1; a <= max; a++) {
      for (let b = 1; b <= max; b++) {
        const prod = a * b;
        if (prod <= max) {
          candidates.push({ a, b, prod });
        }
      }
    }

    // Safety fallback: if somehow no candidates, revert to addition
    if (!candidates.length) {
      const a = randInt(1, max-1);
      const b = randInt(1, Math.max(1, max - a));
      return {
        type: 'arith',
        a,
        b,
        op: '+',
        answer: a + b,
        text: `${a} + ${b} = ?`,
        hint: getHint({ a, b, op: '+' })
      };
    }

    const chosen = candidates[randInt(0, candidates.length - 1)];
    return {
      type: 'arith',
      a: chosen.a,
      b: chosen.b,
      op: '×',                             // display symbol
      answer: chosen.prod,
      text: `${chosen.a} × ${chosen.b} = ?`,
      hint: getHint({ a: chosen.a, b: chosen.b, op: '×' })
    };
  }

  if (fullop === 'add'){
    const a = randInt(1, max-1);
    const b = randInt(1, Math.max(1,max-a));
    return {
      type:'arith',
      a,b,
      op:'+',
      answer:(a+b),
      text:`${a} + ${b} = ?`,
      hint:getHint({a,b,op:'+'})
    };
  } else {
    // SUBTRACTION
    const a = randInt(2, max);
    const b = randInt(1, a-1);
    return {
      type:'arith',
      a,b,
      op:'-',
      answer:(a-b),
      text:`${a} - ${b} = ?`,
      hint:getHint({a,b,op:'-'})
    };
  }
}

function make10Hint(a, b) {
  const need = 10 - a;
  const leftover = b - need;

  if (need > 0 && leftover >= 0) {
    return `${a} needs ${need} to make 10. Take ${need} from ${b}, which leaves ${leftover}. Now think 10 + ${leftover}.`;
  }
  return 'Use the make-10 shortcut: move enough from the second number to the first to build 10, then add what is left.';
}

// Strategy hint text
function getHint({ a, b, op }) {
  // DIVISION HINTS
  if (op === '/') {
    return `Think multiplication: what number times ${b} equals ${a}? ( ? × ${b} = ${a} )`;
  }

   // MULTIPLICATION HINTS
  if (op === '×') {
    // concept: repeated addition & groups
    if (a <= 10 && b <= 10) {
      return `Think of ${a} groups of ${b} (or ${b} groups of ${a}). You can add ${a} ${b} times, or picture an array with ${a} rows and ${b} columns.`;
    }
    // one factor small, one larger
    const bigger = Math.max(a, b);
    const smaller = Math.min(a, b);
    if (smaller <= 5) {
      return `Think repeated addition: start with ${bigger}, then add ${bigger} again and again ${smaller} times in total.`;
    }
    // fallback
    return `Break one number into easier parts. For example, ${a} × ${b} can be split as (${a} × ${Math.floor(b/2)}) + (${a} × ${b - Math.floor(b/2)}).`;
  }

  // SUBTRACTION HINTS
  if (op === '-') {
    if (a <= 10 && b < a) {
      return `Start at ${a}. Count back ${b} steps. Where do you land?`;
    }
    if (b >= 10 && b < a) {
      const extra = b - 10;
      if (extra > 0) {
        return `Take away 10 first. Then take away ${extra} more. How many are left after both steps?`;
      } else {
        return `Take away 10. How many are left?`;
      }
    }
    if (a > 10 && b < a) {
      const tens = Math.floor(a / 10) * 10;
      const distanceToTen = a - tens;
      const stillNeed = b - distanceToTen;
      if (distanceToTen >= b) {
        return `${a} is ${tens} and ${distanceToTen}. Take away ${b} from the ${distanceToTen}. Then put the ${tens} with what is left.`;
      }
      if (stillNeed > 0 && tens - stillNeed >= 0) {
        return `Think of ${a} as ${tens} and ${distanceToTen}. First go down from ${a} to ${tens} (that used ${distanceToTen}). You still need to take away ${stillNeed} more from ${tens}.`;
      }
    }
    return `You have ${a}. You give away ${b}. Picture taking ${b} away. How many are left?`;
  }

  // ADDITION HINTS
  if (a === b) {
    return `Double ${a}. That means counting ${a} two times.`;
  }
  const bigger = Math.max(a, b);
  const smaller = Math.min(a, b);

  if (a <= 10 && b <= 10) {
    if (a + b > 10) {
      return `Make 10 first. Take what you need to get to 10, then add the rest.`;
    }
    return `Start at ${bigger}. Count up ${smaller} more. What number do you get?`;
  }

  const nextFriendly10 = Math.ceil(bigger / 10) * 10;
  const needToFriendly = nextFriendly10 - bigger;
  if (needToFriendly > 0 && needToFriendly < smaller) {
    return `Build a friendly number. Use part of the smaller number to get from ${bigger} up to ${nextFriendly10}. Then add what is left.`;
  }
  return `Put ${a} and ${b} together. Think about adding the smaller number onto the bigger number.`;
}

// Story wording for word mode
function makeStory(cur){
  const patterns = [
    ({a,b,op}) => {
      if (op === '+') {
        return `You have ${a} toy cars and your friend gives you ${b} more. How many now?`;
      }
      if (op === '/') {
        return `You have ${a} toy cars and want to share them equally among ${b} friends. How many does each friend get?`;
      }
      if (op === '×') {
        return `You have ${a} boxes with ${b} toy cars in each box. How many cars in total?`;
      }
      // subtraction default
      return `You had ${a} stickers and gave away ${b}. How many left?`;
    },

    ({a,b,op}) => {
      if (op === '+') {
        return `There are ${a} apples on a tree and ${b} fall down. How many apples total on the ground?`;
      }
      if (op === '/') {
        return `A baker has ${a} apples and puts ${b} apples in each box. How many boxes does he fill?`;
      }
      if (op === '×') {
        return `There are ${a} rows of chairs with ${b} chairs in each row. How many chairs altogether?`;
      }
      // subtraction default
      return `You collected ${a} shells and lost ${b}. How many remain?`;
    },

    ({a,b,op}) => {
      if (op === '+') {
        return `A class reads ${a} pages on Monday and ${b} pages on Tuesday. How many pages total?`;
      }
      if (op === '/') {
        return `A class has ${a} students and they split into groups of ${b}. How many groups are there?`;
      }
      if (op === '×') {
        return `A gardener plants ${a} rows of flowers with ${b} flowers in each row. How many flowers did they plant?`;
      }
      // subtraction default
      return `A baker made ${a} cupcakes and sold ${b}. How many are left?`;
    }
  ];
  const pick = patterns[Math.floor(Math.random()*patterns.length)];
  return pick(cur);
}

/* -------------------------
   RENDER / NEW PROBLEM
------------------------- */

function newProblem(){
  const cur = generateProblem(state.mode, state.op, state.max);
  state.current = cur;
  state.startTime = Date.now();
  state.hintUsed = false;

  feedback.textContent = '';
  hintText.textContent = '';
  visualArea.innerHTML = '';

  if (state.mode === 'word' && cur.type === 'arith') {
    problemArea.textContent = makeStory(cur);
  } else {
    problemArea.textContent = cur.text;
  }

  if (state.mode === 'visual' && (cur.type === 'arith' || cur.type === 'decompose')) {
    renderVisual(cur);
  } else if (state.mode === 'shortcut_make10' && cur.type === 'arith') {
    renderMake10Visual(cur);
  }

  configureAnswerFieldForMode();

  answerInput.value = '';
  answerInput.focus();

  startTimer();
}

// Build the visual (ten-frame style)
function renderVisual(cur){
  let n;
  if (cur.type === 'arith'){
    // For addition: total = a+b. For subtraction: start = a. 
    // For multiplication: total = a × b.
    // For division (a/b): total start amount = a.
    if (cur.op === '+') {
      n = cur.a + cur.b;
    } else if (cur.op === '×') {
      n = cur.a * cur.b;
    } else {
      n = cur.a;
    }
  } else {
    n = cur.n;
  }

  const container = document.createElement('div');
  container.className = 'card';
  container.setAttribute('aria-label','ten-frames');

  // If division, maybe show a hint caption
  if (cur.op === '/') {
    const cap = document.createElement('div');
    cap.className = 'hint';
    cap.style.marginBottom = '8px';
    cap.textContent = `Total: ${n}. Split into groups of ${cur.b} (or ${cur.b} equal groups).`;
    container.appendChild(cap);
  }

  const framesCount = Math.ceil(n/10);
  for (let f=0; f<framesCount; f++){
    const frame = document.createElement('div');
    frame.className='tenframe';
    const base = f*10;
    for (let i=1; i<=10; i++){
      const cell = document.createElement('div');
      cell.className='cell';
      const index = base+i;
      if (index <= n) cell.classList.add('filled');
      frame.appendChild(cell);
    }
    container.appendChild(frame);
  }

  if (cur.type === 'arith' && cur.op === '-') {
    const totalCells = container.querySelectorAll('.cell.filled');
    for (let i=totalCells.length-1, rem=cur.b; rem>0 && i>=0; i--, rem--){
      totalCells[i].classList.add('crossed');
      totalCells[i].classList.remove('filled');
    }
  }

  visualArea.appendChild(container);
}

function renderMake10Visual(cur){
  const { a, b } = cur;

  const container = document.createElement('div');
  container.className = 'card';
  container.setAttribute('aria-label','make-10 visual');

  const title = document.createElement('div');
  title.textContent = 'Make 10 by moving dots:';
  title.style.fontSize = '14px';
  title.style.marginBottom = '4px';
  container.appendChild(title);

  const row = document.createElement('div');
  row.style.display = 'flex';
  row.style.gap = '16px';
  row.style.flexWrap = 'wrap';

  // First frame: starting with "a"
  const frameA = document.createElement('div');
  frameA.className = 'tenframe';
  for (let i = 1; i <= 10; i++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    if (i <= a) cell.classList.add('filled');
    frameA.appendChild(cell);
  }

  // Second frame: starting with "b"
  const frameB = document.createElement('div');
  frameB.className = 'tenframe';
  for (let i = 1; i <= 10; i++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    if (i <= b) cell.classList.add('filled');
    frameB.appendChild(cell);
  }

  row.appendChild(frameA);
  row.appendChild(frameB);
  container.appendChild(row);

  const need = 10 - a;
  const leftover = b - need;

  const expl = document.createElement('div');
  expl.className = 'hint';
  if (need > 0 && leftover >= 0) {
    expl.textContent = `${a} needs ${need} to make 10. Imagine sliding ${need} dots from the second frame to the first. Then you have 10 and ${leftover}.`;
  } else {
    expl.textContent = 'Use the first frame to build 10, then see what is left in the second.';
  }
  container.appendChild(expl);

  visualArea.appendChild(container);
}

/* -------------------------
   ANSWER CHECKING
------------------------- */

// Accept "3+7", "3,7", "3 7"
function parseDecompose(raw){
  const m = raw.match(/(\d+)\s*(?:[,+\s])\s*(\d+)/);
  if(!m) return null;
  return [parseInt(m[1],10), parseInt(m[2],10)];
}

// Generate list like "1+14 • 2+13 • ..."
function allDecomposePairs(n){
  const pairs=[];
  for(let a=1; a<=Math.floor(n/2); a++){
    const b=n-a;
    pairs.push(`${a}+${b}`);
  }
  return pairs;
}

function checkAnswerAndAdvance(){
  if (!state.current) return;

  stopTimer();
  const elapsedMs    = Date.now() - state.startTime;
  const totalSeconds = elapsedMs / 1000;
  const timeDisplay  = formatTime(totalSeconds);  // "mm:ss.ss"

  const cur = state.current;
  const raw = answerInput.value.trim();
  if (!raw){
    feedback.textContent = 'Please type an answer first.';
    startTimer();
    return;
  }

  let correct = false;
  let correctAnswer = null;

  if (cur.type === 'decompose'){
    const parts = parseDecompose(raw);
    if(parts){
      const sum = parts[0] + parts[1];
      correct = (sum === cur.n);
      correctAnswer = null;
    } else {
      feedback.textContent = 'Format example: 3+7 or 3,7';
      startTimer();
      return;
    }
  } else {
    const num = Number(raw);
    if(Number.isFinite(num)){
      correct = (num === cur.answer);
      correctAnswer = cur.answer;
    } else {
      feedback.textContent = 'Please enter a number.';
      startTimer();
      return;
    }
  }

  if (correct){
    if (cur.type === 'decompose'){
      const pairs = allDecomposePairs(cur.n).join(' • ');
      feedback.innerHTML =
        `Correct — all ways to make ${cur.n}: ` +
        `<span style="font-weight:600">${pairs}</span> (took ${timeDisplay})`;
    } else {
      feedback.textContent =
        `Correct — ${problemTextForHistory(cur)} = ${correctAnswer} (took ${timeDisplay})`;
    }
  } else {
    if (cur.type === 'decompose'){
      feedback.textContent =
        `Not quite. Try another way to split ${cur.n}. (took ${timeDisplay})`;
    } else {
      feedback.textContent =
        `Not quite. The answer is ${correctAnswer}. (took ${timeDisplay})`;
    }
  }

  currentSession.stats.attempted++;
  currentSession.stats.times.push(totalSeconds);
  if (correct){
    currentSession.stats.correct++;
    currentSession.stats.streak = (currentSession.stats.streak || 0) + 1;
  } else {
    currentSession.stats.streak = 0;
  }

  // log the attempt with per-attempt timestamp
  currentSession.history.push({
    problemText: displayTextForHistory(cur),
    studentAnswer: raw,
    correct,
    timeTaken: timeDisplay,     // "mm:ss.ss"
    hintUsed: state.hintUsed,
    timestamp: new Date().toISOString()
  });

  persistSession();
  renderStats();
  renderHistoryTable();

  newProblem();
}

function displayTextForHistory(cur){
  if (state.mode === 'word' && cur.type === 'arith') {
    return makeStory(cur);
  }
  return cur.text;
}

function problemTextForHistory(cur){
  if (cur.type === 'arith'){
    return `${cur.a} ${cur.op} ${cur.b}`;
  } else {
    return cur.text;
  }
}

/* -------------------------
   STATS + HISTORY UI
------------------------- */

function averageTime(times){
  if (!times.length) return 0;
  const sum = times.reduce((a,b)=>a+b,0);
  return Math.round(sum / times.length);
}

function renderStats(){
  statCorrect.textContent   = currentSession.stats.correct || 0;
  statAttempted.textContent = currentSession.stats.attempted || 0;
  statAvgTime.textContent   = averageTime(currentSession.stats.times);
  statStreak.textContent    = currentSession.stats.streak || 0;
}

function renderHistoryTable(){
  historyBody.innerHTML = '';
  const rows = [...currentSession.history].slice().reverse();
  for (const item of rows){
    const tr = document.createElement('tr');
    tr.className = item.correct ? 'correct' : 'wrong';

    const tdProb = document.createElement('td');
    tdProb.textContent = item.problemText;

    const tdAns = document.createElement('td');
    tdAns.textContent = item.studentAnswer;

    const tdCor = document.createElement('td');
    tdCor.textContent = item.correct ? 'Yes' : 'No';

    const tdTime = document.createElement('td');
    tdTime.textContent = item.timeTaken;

    const tdHint = document.createElement('td');
    tdHint.textContent = item.hintUsed ? 'Yes' : 'No';

    tr.appendChild(tdProb);
    tr.appendChild(tdAns);
    tr.appendChild(tdCor);
    tr.appendChild(tdTime);
    tr.appendChild(tdHint);

    historyBody.appendChild(tr);
  }
}

/* -------------------------
   HINTS
------------------------- */

function showHint(){
  const cur = state.current;
  if (!cur) return;
  state.hintUsed = true;

  if (cur.type === 'decompose'){
    hintText.textContent = cur.hint ||
      `Think of two numbers that add to ${cur.n}. Start small and work up.`;
  } else if (cur.type === 'arith'){
    hintText.textContent = cur.hint ||
      'Use what you know about tens to solve it.';
  } else {
    hintText.textContent = 'Think carefully about what the story is asking.';
  }
}

/* -------------------------
   INPUT / TIMING / EVENTS
------------------------- */

function configureAnswerFieldForMode(){
  if (state.current && state.current.type === 'decompose'){
    answerInput.setAttribute('type','text');
    answerInput.setAttribute('inputmode','numeric');
    answerInput.setAttribute('pattern','[0-9, +]*');
    answerInput.removeAttribute('step');
    answerInput.placeholder = 'Type two whole numbers, like 2+3';
  } else {
    answerInput.setAttribute('type','number');
    answerInput.setAttribute('inputmode','numeric');
    answerInput.setAttribute('pattern','[0-9]*');
    answerInput.setAttribute('step','1');
    answerInput.placeholder = 'Type answer';
  }
}

// sanitize paste
answerInput.addEventListener('paste',(e)=>{
  e.preventDefault();
  const text=(e.clipboardData||window.clipboardData).getData('text')||'';
  const cleaned = (state.current && state.current.type === 'decompose')
    ? text.replace(/[^0-9,+ ]/g,'')
    : text.replace(/[^0-9]/g,'');
  document.execCommand('insertText', false, cleaned);
});

// block invalid keys, N shortcut
answerInput.addEventListener('keydown',(e)=>{
  if (e.key === 'Enter'){
    return; // form submit will handle
  }
  if ((e.key === 'n' || e.key === 'N') &&
      !e.ctrlKey && !e.metaKey && !e.altKey && !e.altGraphKey){
    e.preventDefault();
    newProblem();
    return;
  }
  const navKeys=['Backspace','Delete','ArrowLeft','ArrowRight','Tab','Home','End'];
  if (navKeys.includes(e.key) || e.ctrlKey || e.metaKey){
    return;
  }
  const ok = (state.current && state.current.type==='decompose')
    ? /[0-9,+ ]/.test(e.key)
    : /[0-9]/.test(e.key);
  if (!ok){
    e.preventDefault();
  }
});

// global N / H shortcuts when not typing
function globalKeydown(e){
  if (e.target === answerInput) return;
  if (e.key.toLowerCase() === 'n'){
    newProblem();
  }
  if (e.key.toLowerCase() === 'h'){
    showHint();
  }
}

// timing
function startTimer(){
  stopTimer();
  timerEl.textContent = 'Time: 0s';
  state.startTime = Date.now();
  state.timerInt = setInterval(()=>{
    timerEl.textContent = 'Time: ' +
      Math.round((Date.now()-state.startTime)/1000) + 's';
  },300);
}
function stopTimer(){
  if (state.timerInt){
    clearInterval(state.timerInt);
    state.timerInt = null;
  }
}

/* -------------------------
   WIRE UI
------------------------- */

function wireUI(){
  if (wireUI._wired) return;
  wireUI._wired = true;

  answerForm.addEventListener('submit',(e)=>{
    e.preventDefault();
    checkAnswerAndAdvance();
  });

  nextBtn.addEventListener('click',()=>{
    newProblem();
  });

  hintBtn.addEventListener('click',()=>{
    showHint();
  });

  downloadSessionBtn.addEventListener('click', () => {
    downloadSessionCSV();
  });

  resetStatsBtn.addEventListener('click',()=>{
    if (confirm('This will erase all saved sessions and progress. Are you sure?')){
      localStorage.removeItem(SESSIONS_KEY);
      currentSession = createNewSession();
      persistSession();
      renderStats();
      renderHistoryTable();
      newProblem();
    }
  });

  document.addEventListener('keydown', globalKeydown);

  modeSelect.addEventListener('change', (e)=>{
    state.mode = e.target.value;
    newProblem();
  });

  opSelect.addEventListener('change', (e)=>{
    state.op = e.target.value;
    newProblem();
  });

  maxNumber.addEventListener('change', (e)=>{
    let v = parseInt(e.target.value,10);
    if (!Number.isFinite(v)) v = 20;
    v = Math.max(5, Math.min(100, v));
    state.max = v;
    maxNumber.value = v;
    newProblem();
  });
}
