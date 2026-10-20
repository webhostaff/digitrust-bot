'use strict';
/**
 * V166 — Smart reply assistant (staff replies only).
 *
 * What it does with a draft the staff typed:
 *   1. FIXES the whole sentence, not only known typos: spelling (big dictionary), spacing, punctuation, capital
 *      letters, "i" → "I", doubled words, doubled punctuation, a closing full stop — and a small set of
 *      support-tone phrase upgrades ("send me ur email" → "Please send me your email address.").
 *   2. UNDERSTANDS what the draft is about (English, Arabic, Tunisian written in Latin letters) and offers a
 *      ready, professional reply for that situation as an alternative.
 *   3. With an AI key (ANTHROPIC_API_KEY / OPENAI_API_KEY — the same ones Sahbi uses) it rewrites the draft in the
 *      customer's language, keeping every link / e-mail / number / price exactly. If the AI is missing, slow or
 *      wrong, the offline engine above answers — the reply is never blocked.
 *
 * It NEVER changes links, @handles, #tags, e-mails, numbers, prices or code, and nothing leaves without a tap.
 */
const axios = require('axios');
const logger = require('../utils/logger');
const { DICT: BASE_DICT } = require('./typoFix');

// ── 1) dictionary (merged with the V162 list) ───────────────────────────────
const MORE = {
  // common slips
  recive: 'receive', recieve: 'receive', reciept: 'receipt', recipt: 'receipt', wating: 'waiting', waitng: 'waiting',
  tomorow: 'tomorrow', tomorro: 'tomorrow', todya: 'today', toady: 'today', tonite: 'tonight', tnx: 'thanks', thanks: 'thanks',
  thnks: 'thanks', thankyou: 'thank you', thankx: 'thanks', thanku: 'thank you', welcom: 'welcome', plese: 'please', plase: 'please',
  pleae: 'please', kindly: 'kindly', sory: 'sorry', soory: 'sorry', aplogies: 'apologies', apologys: 'apologies',
  confrim: 'confirm', confirmd: 'confirmed', cofirm: 'confirm', verfiy: 'verify', verfy: 'verify', veryfy: 'verify',
  chek: 'check', cheking: 'checking', chack: 'check', checkd: 'checked', cheked: 'checked',
  sned: 'send', snd: 'send', sennt: 'sent', sendd: 'send', sendin: 'sending', resend: 'resend', resending: 'resending',
  provid: 'provide', provde: 'provide', provided: 'provided', informaton: 'information', infomation: 'information', infromation: 'information',
  invitaion: 'invitation', invitaton: 'invitation', invtation: 'invitation', invit: 'invite', inviet: 'invite', invte: 'invite',
  acept: 'accept', accpet: 'accept', accepte: 'accept', acces: 'access', accesss: 'access', acess: 'access',
  logn: 'login', loggin: 'login', loging: 'logging', pasword: 'password', passwrod: 'password', pasword: 'password', passowrd: 'password',
  emial: 'email', emal: 'email', mial: 'mail', gmial: 'Gmail', gmai: 'Gmail', gmal: 'Gmail', hotmial: 'Hotmail',
  subscrption: 'subscription', subscribtion: 'subscription', subcription: 'subscription', subsription: 'subscription',
  perminant: 'permanent', permenant: 'permanent', premium: 'premium', premuim: 'premium', prmeium: 'premium',
  warrenty: 'warranty', garantee: 'guarantee', gaurantee: 'guarantee', guarentee: 'guarantee',
  replacment: 'replacement', replacemnt: 'replacement', replce: 'replace', refud: 'refund', refnd: 'refund', rufund: 'refund',
  deliverd: 'delivered', delievered: 'delivered', delivary: 'delivery', delivry: 'delivery', delievery: 'delivery',
  oder: 'order', ordr: 'order', ordeer: 'order', purchse: 'purchase', purchace: 'purchase', purcahse: 'purchase', bought: 'bought',
  paymnt: 'payment', pyament: 'payment', paymant: 'payment', transfered: 'transferred', transfer: 'transfer', trasnfer: 'transfer',
  recieved: 'received', receved: 'received', credted: 'credited', crediting: 'crediting', balence: 'balance', ballance: 'balance',
  workng: 'working', wroking: 'working', wokring: 'working', worked: 'worked', wrking: 'working', doesent: "doesn't", dosent: "doesn't",
  dnt: "don't", didnt: "didn't", havent: "haven't", hasnt: "hasn't", hadnt: "hadn't", cannot: 'cannot', cnt: "can't",
  thats: "that's", whats: "what's", heres: "here's", theres: "there's", youve: "you've", youll: "you'll",
  theyre: "they're", weve: "we've", werent: "weren't", hows: "how's", whos: "who's", itll: "it'll",
  jus: 'just', jst: 'just', stil: 'still', allready: 'already', alredy: 'already', alrady: 'already', alwys: 'always',
  anythng: 'anything', somthing: 'something', somthin: 'something', everthing: 'everything', everyting: 'everything', nothin: 'nothing',
  anyone: 'anyone', anywya: 'anyway', anyways: 'anyway', abit: 'a bit', atleast: 'at least', infact: 'in fact', inorder: 'in order',
  wihtin: 'within', withing: 'within', widhin: 'within', witout: 'without', whithout: 'without', durring: 'during', duing: 'during',
  befor: 'before', befroe: 'before', afther: 'after', aftr: 'after', beacuse: 'because', becouse: 'because', bcz: 'because', coz: 'because', cuz: 'because',
  thru: 'through', trough: 'through', thorugh: 'through', thoght: 'thought', thougth: 'thought', throught: 'thought',
  diffrent: 'different', diferent: 'different', differnt: 'different', imediately: 'immediately', immediatly: 'immediately', imediatly: 'immediately',
  quicly: 'quickly', quickky: 'quickly', quikly: 'quickly', soonn: 'soon', asap: 'as soon as possible', shortly: 'shortly',
  usualy: 'usually', ususally: 'usually', realy: 'really', reallly: 'really', actualy: 'actually', actully: 'actually', probaly: 'probably', probabely: 'probably',
  possibl: 'possible', posible: 'possible', imposible: 'impossible', neccessary: 'necessary', necesary: 'necessary', neccesary: 'necessary',
  usefull: 'useful', helpfull: 'helpful', helpfulll: 'helpful', carefull: 'careful', successfull: 'successful', thankfull: 'thankful',
  mistke: 'mistake', mistak: 'mistake', mistaken: 'mistaken', erorr: 'error', eror: 'error', erro: 'error', issu: 'issue', isue: 'issue', problam: 'problem', probelm: 'problem',
  wrnog: 'wrong', wornge: 'wrong', wrog: 'wrong', corect: 'correct', corrct: 'correct', corected: 'corrected', incorect: 'incorrect',
  sevice: 'service', servise: 'service', servic: 'service', suport: 'support', suppport: 'support', supprt: 'support', custmer: 'customer', custumer: 'customer', costumer: 'customer', costomer: 'customer',
  produt: 'product', prodcut: 'product', proudct: 'product', prduct: 'product', prodct: 'product', stok: 'stock', stoke: 'stock', avilable: 'available', avaialble: 'available', avalable: 'available',
  usr: 'user', usrname: 'username', usernmae: 'username', websit: 'website', webiste: 'website', wesbite: 'website', lisence: 'license', liscense: 'license',
  tem: 'team', teem: 'team', workspce: 'workspace', worspace: 'workspace', worksapce: 'workspace', memebr: 'member', membr: 'member', memeber: 'member', memebers: 'members',
  scren: 'screen', screnshot: 'screenshot', screeshot: 'screenshot', scrnshot: 'screenshot', scrennshot: 'screenshot', ss: 'screenshot',
  vedio: 'video', viedo: 'video', vidoe: 'video', phot: 'photo', pictuer: 'picture', pictre: 'picture', pic: 'picture', pics: 'pictures',
  mesage: 'message', messge: 'message', mesasge: 'message', msg: 'message', msgs: 'messages', mssg: 'message', chatt: 'chat',
  repley: 'reply', repy: 'reply', replly: 'reply', ansewr: 'answer', answr: 'answer', anwser: 'answer', questoin: 'question', quesiton: 'question', qestion: 'question',
  lnk: 'link', lnks: 'links', linkk: 'link', linkss: 'links', urls: 'URLs', url: 'URL', gemni: 'Gemini', gemeni: 'Gemini', geminy: 'Gemini', gemin: 'Gemini',
  chatgpt: 'ChatGPT', chat_gpt: 'ChatGPT', chargpt: 'ChatGPT', chatgbt: 'ChatGPT', canvaa: 'Canva', canba: 'Canva', cnva: 'Canva', capcutt: 'CapCut', youtub: 'YouTube', youtue: 'YouTube',
  spotfy: 'Spotify', spotifi: 'Spotify', netflex: 'Netflix', netflx: 'Netflix', adobee: 'Adobe', adobi: 'Adobe', telgram: 'Telegram', telegam: 'Telegram', telegrm: 'Telegram',
  binnace: 'Binance', binace: 'Binance', binanse: 'Binance', usdt: 'USDT', paypall: 'PayPal', payper: 'PayPal',
  mintue: 'minute', minite: 'minute', minuet: 'minute', minuets: 'minutes', secound: 'second', secod: 'second', hr: 'hour', hrs: 'hours', hou: 'hour',
  mnth: 'month', mounth: 'month', mnths: 'months', yeer: 'year', yrs: 'years', wek: 'week', weeek: 'week', dayy: 'day',
  okey: 'okay', okk: 'okay', okai: 'okay', yess: 'yes', yea: 'yes', yeah: 'yes', yep: 'yes', nope: 'no', noo: 'no',
  helo: 'hello', hllo: 'hello', helllo: 'hello', hii: 'hi', heyy: 'hey', gud: 'good', goood: 'good', morning: 'morning', evning: 'evening', nite: 'night',
  wlcome: 'welcome', youre: "you're", yourself: 'yourself', urself: 'yourself', ppl: 'people', peple: 'people', pepole: 'people', prson: 'person', persn: 'person',
  tryed: 'tried', triying: 'trying', tring: 'trying', tryin: 'trying', usng: 'using', usin: 'using', useing: 'using', usd: 'used', bein: 'being', beeen: 'been', gonna: 'going to', wanna: 'want to', gotta: 'have to',
  shold: 'should', shouldd: 'should', wold: 'would', woud: 'would', cld: 'could', cuold: 'could', migth: 'might', mgiht: 'might',
  somthing: 'something', someting: 'something', somone: 'someone', sombody: 'somebody', ther: 'there', thre: 'there', thier: 'their', theyr: "they're",
  evrything: 'everything', evryone: 'everyone', everyon: 'everyone', evry: 'every', evrey: 'every', enough: 'enough', enogh: 'enough', enuf: 'enough',
  begining: 'beginning', beggining: 'beginning', finnaly: 'finally', finaly: 'finally', finall: 'final', compleate: 'complete', complet: 'complete', completd: 'completed', compelted: 'completed',
  proccess: 'process', proces: 'process', procesing: 'processing', proccessing: 'processing', procssing: 'processing', compleated: 'completed',
  updat: 'update', updte: 'update', updted: 'updated', upgrd: 'upgrade', instal: 'install', instll: 'install', instaled: 'installed', downlod: 'download', dowload: 'download', uplod: 'upload',
  chang: 'change', chnge: 'change', chaged: 'changed', chnged: 'changed', chanage: 'change', renw: 'renew', renewl: 'renewal', renwal: 'renewal', expir: 'expire', expird: 'expired', expiry: 'expiry', expration: 'expiration',
  extention: 'extension', extnd: 'extend', exend: 'extend', remindr: 'reminder', remnder: 'reminder', noitce: 'notice', notic: 'notice', notifcation: 'notification',
  contct: 'contact', contac: 'contact', contacte: 'contact', conact: 'contact', directy: 'directly', direclty: 'directly', direct: 'direct', privat: 'private', priavte: 'private',
};
const DICT = { ...BASE_DICT, ...MORE };
// words that are valid as written and must never be "corrected" even if a dictionary key collides
const KEEP = new Set(['its', 'ill', 'im', 'ive', 'activate', 'thanks', 'resend', 'bought', 'cannot', 'morning', 'kindly', 'premium', 'direct', 'enough',
  'anyone', 'worked', 'shortly', 'transfer', 'actually', 'final', 'chat', 'usd', 'ss', 'pic', 'pics', 'url', 'urls', 'hr', 'hrs', 'msg', 'msgs', 'asap', 'usdt', 'yeah', 'yep', 'nope', 'gonna', 'wanna', 'gotta', 'yea']);
// contractions the owner may want kept short; "its"/"ill"/"im" collide with real words so they are only fixed when standalone-lower in V162 list
const SAFE_SKIP = new Set(['its', 'ill', 'im', 'ive']);

// ── protected tokens (links, @, #, e-mail, numbers/prices, code) ────────────
const PROTECT = /(https?:\/\/\S+|www\.\S+|\S+@\S+\.\S+|[@#\/][\w.\-]+|`[^`]*`|<[^>]+>|[$€£]\s?\d[\d.,]*|\b\d[\d.,:/\-]*\w*\b|\b\w*[_=+\\|]\w*\b|\b[A-Za-z]+\.[A-Za-z]{2,}\b)/g;

function matchCase(src, repl) {
  if (src.length > 1 && src === src.toUpperCase()) return repl.toUpperCase();
  if (src[0] === src[0].toUpperCase() && src.slice(1) === src.slice(1).toLowerCase()) return repl[0].toUpperCase() + repl.slice(1);
  return repl;
}

// ── 2) phrase upgrades (support tone) ───────────────────────────────────────
const PHRASES = [
  [/\bsend (?:me )?(?:ur|your) (?:email|mail|gmail)\b/i, 'please send me your email address'],
  [/\bgive (?:me )?(?:ur|your) (?:email|mail|gmail)\b/i, 'please send me your email address'],
  [/\bwait (?:a )?(?:bit|sec|second|moment|min|minute)s?\b/i, 'please wait a moment'],
  [/\btry again\b/i, 'please try again'],
  [/\bcheck (?:ur|your) (?:inbox|mail|email|spam)\b/i, 'please check your inbox (and the Spam folder)'],
  [/\bsend (?:me )?(?:a )?screenshot\b/i, 'please send me a screenshot'],
  [/\bsend (?:me )?(?:the )?(?:order|order number|order id)\b/i, 'please send me your order number'],
];

function sentenceFix(s) {
  let t = s;
  t = t.replace(/[ \t]{2,}/g, ' ');
  t = t.replace(/\s+([,.!?;:])/g, '$1');                       // no space before punctuation
  t = t.replace(/([,;!?])(?=[A-Za-z؀-ۿ])/g, '$1 ');   // space after , ; ! ?
  t = t.replace(/(\.)(?=[A-Z][a-z])/g, '$1 ');                  // "done.Thanks" → "done. Thanks"
  t = t.replace(/([!?]){2,}/g, '$1');                           // "!!!" → "!"
  t = t.replace(/\.{4,}/g, '...');
  t = t.replace(/,{2,}/g, ',');
  t = t.replace(/\b(\w+)\s+\1\b/gi, (m, w) => (/^\d+$/.test(w) || w.length < 2 ? m : w)); // "the the" → "the"
  t = t.replace(/\bi\b(?=(?:\s|'|,|\.|!|\?|$))/g, 'I');
  t = t.replace(/\bi'(m|ll|ve|d)\b/g, (m, x) => "I'" + x);
  t = t.replace(/\b(its) (?=(?:working|fine|done|ready|ok|okay|good|not|been|going|now|available|activated|active|correct|possible|a|the)\b)/gi, (m, w) => (w[0] === 'I' ? "It's " : "it's "));
  // capital letter after . ! ? and at the start
  t = t.replace(/(^|[.!?]\s+|\n\s*)([a-z])/g, (m, a, b) => a + b.toUpperCase());
  return t.trim();
}

/** Offline engine → { fixed, changes:[{from,to}] }. */
function fixSentence(input) {
  const text = String(input || '');
  if (!text.trim()) return { fixed: text, changes: [] };
  // 1) hide protected tokens
  const vault = [];
  let t = text.replace(PROTECT, (m) => { vault.push(m); return `\u0001${vault.length - 1}\u0002`; });
  const changes = [];
  // 2) word-by-word dictionary
  t = t.replace(/[A-Za-z][A-Za-z']*/g, (w) => {
    const key = w.toLowerCase();
    if (KEEP.has(key) && !(key === 'its' || key === 'ill' || key === 'im' || key === 'ive')) return w;
    if (SAFE_SKIP.has(key)) {
      // only the obvious slips: "im" / "ive" / "ill" typed lower-case as a standalone word
      if (w !== key) return w;
      if (key === 'its') return w;                    // too ambiguous — leave alone
      const fix = key === 'im' ? "I'm" : key === 'ive' ? "I've" : "I'll";
      changes.push({ from: w, to: fix }); return fix;
    }
    if (Object.prototype.hasOwnProperty.call(DICT, key) && DICT[key] !== key) {
      const r = matchCase(w, DICT[key]);
      if (r !== w) { changes.push({ from: w, to: r }); return r; }
    }
    return w;
  });
  // 3) phrase upgrades
  // Only when the phrase IS the whole message — inside a longer sentence an in-place swap makes run-ons.
  for (const [re, to] of PHRASES) {
    const whole = new RegExp('^\\s*(?:please\\s+|can you\\s+|could you\\s+)?(?:' + re.source + ')\\s*[.!]*\\s*$', 'i');
    if (whole.test(t)) { changes.push({ from: t.trim(), to }); t = to[0].toUpperCase() + to.slice(1); break; }
  }
  // 4) whole-sentence hygiene
  const before = t;
  const wc = t.replace(/\u0001\d+\u0002/g, 'x').split(/\s+/).filter(Boolean).length;
  if (wc >= 3) t = sentenceFix(t);                 // one or two words ("ok", "done") are left as typed
  // 5) closing full stop on a real sentence
  const plain = t.replace(/\u0001\d+\u0002/g, 'x');
  const words = plain.split(/\s+/).filter(Boolean).length;
  if (words >= 3 && /[A-Za-z0-9)\u0002]$/.test(t) && !/[.!?:]$/.test(t) && !/\u0001\d+\u0002$/.test(t)) t += '.';
  if (t !== before && !changes.length) changes.push({ from: 'punctuation / capitals', to: 'tidied' });
  // 6) restore protected tokens
  t = t.replace(/\u0001(\d+)\u0002/g, (m, i) => vault[Number(i)]);
  return { fixed: t, changes };
}

// ── 3) intent → ready replies ───────────────────────────────────────────────
const INTENTS = [
  { id: 'invite_sent', label: 'Invitation sent',
    re: /(invit|دعو|دعوة|دعوه|inviti|ba3ath.*invit|ab3ath.*invit)/i, and: /(sent|send|done|check|inbox|spam|accept|بعث|ارسل|أرسل|تم|شوف|افتح|check)/i,
    replies: [
      'Your invitation has been sent. Please check your email inbox (and the Spam folder) and press "Accept invitation". Let me know if it does not arrive within a few minutes.',
      'Done ✅ I have sent the invitation to your email. Please accept it from the email, and tell me if you need any help.',
    ] },
  { id: 'need_email', label: 'Need the e-mail',
    re: /(e-?mail|gmail|mail|ايميل|إيميل|امايل|ميل)/i, and: /(send|give|need|provide|share|what|which|اعطي|ارسل|أرسل|ابعث|اعطيني|نحتاج|نحب|اكتب|عطيني)/i,
    replies: [
      'Please send me the email address you want the subscription on, and I will take care of it right away.',
      'Could you send the exact email address (the one you sign in with)? I will activate it as soon as I have it.',
    ] },
  { id: 'wait', label: 'Please wait',
    re: /(wait|moment|minute|min\b|few min|soon|checking|check it|looking|working on|استن|انتظر|دقيق|شوي|نشوف|نراجع|نتحقق|نخدم)/i,
    replies: [
      'Thank you for your patience. I am checking this right now and will update you in a few minutes.',
      'Give me a moment please — I am working on it and will come back to you shortly.',
    ] },
  { id: 'replacement', label: 'Replacement',
    re: /(replac|new link|another link|not work|dead|expired link|stopped|بديل|رابط جديد|ما يخدم|لا يعمل|معطل|ماعاد يخدم|بدل)/i,
    replies: [
      'Sorry about that! I am sending you a new working link now — please try it and tell me if it works.',
      "I'm sorry for the trouble. Here is a replacement; please try it and let me know the result.",
    ] },
  { id: 'refund', label: 'Refund',
    re: /(refund|money back|cancel|رجع|استرجاع|استرداد|فلوس|الفلوس|نرجعلك|ارجاع)/i,
    replies: [
      'I understand. I have noted your refund request and will review it right away; you will hear from me shortly.',
      'Your request has been received. Please send your order number and I will process it as quickly as possible.',
    ] },
  { id: 'payment', label: 'Payment check',
    re: /(payment|paid|deposit|txid|transaction|hash|wallet|binance|دفع|دفعت|حوالة|ايداع|إيداع|تحويل|رصيد)/i,
    replies: [
      'Thank you. I am verifying your payment now; it usually takes a few minutes and I will confirm here as soon as it is credited.',
      'I can see your message about the payment. Please send the TXID or a screenshot so I can verify it quickly.',
    ] },
  { id: 'delivered', label: 'Delivered',
    re: /(delivered|ready|completed|finished|activated|sent you|تم التسليم|جاهز|تم تفعيل|فعّلت|فعلت|خلصت|وصلك)/i,
    replies: [
      'Your order is ready ✅ Everything has been delivered. Please check and tell me if you need anything else.',
      'All done! Your product has been activated. Tell me if you face any problem and I will help immediately.',
    ] },
  { id: 'thanks', label: 'Thanks',
    re: /(thank|thx|appreciat|welcome|شكرا|شكراً|بارك|مشكور|عفوا|عفواً|يعطيك)/i,
    replies: [
      "You're welcome! Thank you for choosing us — message me any time you need help. 🙏",
    ] },
  { id: 'sorry', label: 'Apology',
    re: /(sorry|apolog|mistake|my bad|اسف|آسف|أسف|سامحني|غلطة|خطأ|خطا)/i,
    replies: [
      'I am sorry for the inconvenience — it was our mistake and I am fixing it right now. Thank you for your understanding.',
    ] },
];

function detectIntent(text) {
  const s = String(text || '');
  let best = null;
  for (const it of INTENTS) {
    if (!it.re.test(s)) continue;
    if (it.and && !it.and.test(s)) continue;
    best = it; break;
  }
  return best;
}

function suggestionsFor(text) {
  const it = detectIntent(text);
  return it ? { id: it.id, label: it.label, replies: it.replies } : null;
}

// ── 4) optional AI rewrite ──────────────────────────────────────────────────
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const PROVIDER = (process.env.AGENT_PROVIDER || '').toLowerCase() || (ANTHROPIC_KEY ? 'anthropic' : (OPENAI_KEY ? 'openai' : ''));
const MODELS = {
  anthropic: [process.env.REPLY_AI_MODEL, 'claude-sonnet-5', 'claude-sonnet-4-6'].filter(Boolean),
  openai: [process.env.REPLY_AI_MODEL, 'gpt-6-luna', 'gpt-5.6-luna', 'gpt-4o-mini'].filter(Boolean),
};
let modelIdx = 0;
const aiReady = () => !!((PROVIDER === 'openai' && OPENAI_KEY) || (PROVIDER === 'anthropic' && ANTHROPIC_KEY));

const SYSTEM = `You polish a store support agent's DRAFT before it is sent to a customer.
Do all of this:
- Understand what the agent means (the draft may be English, Arabic, Tunisian dialect, or mixed) and write it as a clear, warm, professional support reply.
- Reply in the CUSTOMER's language (given below); if unknown, use English.
- Fix spelling, grammar, punctuation, capital letters. Improve wording and meaning. Keep it short (usually 1-3 sentences).
- Keep every link, @handle, e-mail, order number, number and price EXACTLY as written. Never invent facts, promises, prices or times that the draft does not contain.
- Do not add greetings or signatures unless the draft has them.
Answer ONLY with JSON: {"polished":"...","intent":"2-4 words","alt":"a different good wording (optional)"}`;

async function aiRewrite(draft, { customerText = '', customerLang = '' } = {}) {
  if (!aiReady()) return null;
  const user = `Customer's language: ${customerLang || 'same as the customer message below, else English'}\n` +
    (customerText ? `Customer's last message:\n"""${String(customerText).slice(0, 600)}"""\n` : '') +
    `Agent's draft:\n"""${String(draft).slice(0, 1500)}"""`;
  const chain = MODELS[PROVIDER] || [];
  for (let k = modelIdx; k < chain.length; k++) {
    try {
      let out = '';
      if (PROVIDER === 'anthropic') {
        const r = await axios.post('https://api.anthropic.com/v1/messages', {
          model: chain[k], max_tokens: 500, system: SYSTEM, messages: [{ role: 'user', content: user }],
        }, { headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 15000 });
        out = (r.data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
      } else {
        const r = await axios.post('https://api.openai.com/v1/chat/completions', {
          model: chain[k], max_tokens: 500, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
          response_format: { type: 'json_object' },
        }, { headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'content-type': 'application/json' }, timeout: 15000 });
        out = r.data.choices?.[0]?.message?.content || '';
      }
      modelIdx = k;
      const j = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
      const polished = String(j.polished || '').trim();
      if (!polished) return null;
      return { polished, intent: String(j.intent || '').slice(0, 40), alt: String(j.alt || '').trim() };
    } catch (e) {
      const st = e.response?.status;
      if (st === 404 || st === 400) { modelIdx = k + 1; continue; }   // model not available for this key → next one
      logger.warn(`[replyAssist] AI rewrite failed: ${e.message}`);
      return null;
    }
  }
  return null;
}

/** every protected token of the draft must still be in the AI text, unchanged */
function keepsProtected(draft, out) {
  const toks = String(draft).match(PROTECT) || [];
  return toks.every((t) => out.includes(t));
}

function guessLang(s) {
  const t = String(s || '');
  if (/[؀-ۿ]/.test(t)) return 'Arabic';
  if (/\b(bonjour|merci|salut|svp|commande|probl[eè]me)\b/i.test(t)) return 'French';
  return '';
}

/**
 * Main entry. Returns:
 *   { fixed, changes, ai: bool, intent: {id,label}|null, suggestions: [string], note }
 * `fixed` is what the "Send improved" button sends.
 */
async function analyze(draft, { customerText = '' } = {}) {
  const off = fixSentence(draft);
  const sug = suggestionsFor(draft);
  const res = { fixed: off.fixed, changes: off.changes, ai: false, intent: sug ? { id: sug.id, label: sug.label } : null, suggestions: sug ? sug.replies.slice(0, 2) : [] };
  const arabicDraft = /[؀-ۿ]/.test(draft);
  if (aiReady() && String(draft).trim().split(/\s+/).length >= 2) {
    const r = await aiRewrite(draft, { customerText, customerLang: guessLang(customerText) });
    if (r && keepsProtected(draft, r.polished)) {
      res.ai = true; res.fixed = r.polished;
      if (r.intent) res.intent = { id: 'ai', label: r.intent };
      if (r.alt && keepsProtected(draft, r.alt) && r.alt !== r.polished) res.suggestions = [r.alt, ...res.suggestions].slice(0, 2);
      res.changes = [{ from: 'draft', to: 'rewritten' }];
    }
  }
  // An Arabic draft without AI cannot be "fixed" into English offline — the ready replies are the useful part.
  if (arabicDraft && !res.ai) { res.fixed = draft; res.changes = []; }
  return res;
}

module.exports = { analyze, fixSentence, detectIntent, suggestionsFor, aiReady, DICT };
