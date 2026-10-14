'use strict';
// V162: a safe, conservative auto-correct for STAFF replies only.
// It only fixes a fixed list of very common English typos, word-for-word, and NEVER touches:
// links, @handles, #tags, emails, numbers, code, or any word it doesn't know. Case is preserved.

const DICT = {
  teh: 'the', thsi: 'this', taht: 'that', wiht: 'with', adn: 'and', nad: 'and', ot: 'to', fo: 'of',
  yuo: 'you', youre: "you're", ur: 'your', u: 'you', plz: 'please', pls: 'please', thx: 'thanks', thanx: 'thanks',
  recieve: 'receive', recieved: 'received', recieving: 'receiving', beleive: 'believe', acheive: 'achieve',
  seperate: 'separate', definately: 'definitely', occured: 'occurred', occuring: 'occurring',
  adress: 'address', adresses: 'addresses', accont: 'account', acount: 'account', acounts: 'accounts',
  payement: 'payment', payed: 'paid', refered: 'referred', tommorow: 'tomorrow', tommorrow: 'tomorrow',
  untill: 'until', wich: 'which', wil: 'will', woudl: 'would', shoudl: 'should', coudl: 'could',
  dont: "don't", cant: "can't", wont: "won't", doesnt: "doesn't", didnt: "didn't", isnt: "isn't",
  wasnt: "wasn't", arent: "aren't", couldnt: "couldn't", wouldnt: "wouldn't", shouldnt: "shouldn't",
  im: "I'm", ive: "I've", ill: "I'll", its: 'it is', thier: 'their', freind: 'friend', alot: 'a lot',
  becuase: 'because', becasue: 'because', agian: 'again', agin: 'again', workin: 'working', workign: 'working',
  activ: 'active', activ8: 'activate', activate: 'activate', suscription: 'subscription', subsciption: 'subscription',
  availabe: 'available', availible: 'available', succesfully: 'successfully', succesful: 'successful',
  sucessfully: 'successfully', orderr: 'order', linkk: 'link', herre: 'here', pleas: 'please',
  welcom: 'welcome', wellcome: 'welcome', sry: 'sorry', srry: 'sorry', sorri: 'sorry', problm: 'problem',
  problme: 'problem', minut: 'minute', minuts: 'minutes', momment: 'moment', momnet: 'moment',
};

// a token is "protected" (never changed) if it looks like a link / handle / email / code / number
function isProtected(tok) {
  return (
    /https?:\/\//i.test(tok) ||
    /^[@#\/]/.test(tok) ||
    /\S+@\S+\.\S+/.test(tok) ||
    /\d/.test(tok) ||
    /[_`<>{}\[\]\\|=+]/.test(tok) ||
    /[A-Za-z]\.[A-Za-z]/.test(tok) ||       // like one.google
    tok.length > 24
  );
}

function matchCase(src, repl) {
  if (src === src.toUpperCase() && src.length > 1) return repl.toUpperCase();
  if (src[0] === src[0].toUpperCase()) return repl[0].toUpperCase() + repl.slice(1);
  return repl;
}

/**
 * Returns { fixed, changes:[{from,to}] }. `fixed` equals the input if nothing changed.
 * Splits on spaces so punctuation stays attached and is re-attached after the fix.
 */
function fixTypos(text) {
  if (!text || typeof text !== 'string') return { fixed: text, changes: [] };
  const changes = [];
  const out = text.split(/(\s+)/).map((tok) => {
    if (/^\s+$/.test(tok) || !tok) return tok;
    if (isProtected(tok)) return tok;
    // peel leading/trailing punctuation
    const m = /^([^A-Za-z']*)([A-Za-z'][A-Za-z']*)([^A-Za-z']*)$/.exec(tok);
    if (!m) return tok;
    const [, pre, word, post] = m;
    const key = word.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(DICT, key)) {
      const repl = matchCase(word, DICT[key]);
      if (repl !== word) { changes.push({ from: word, to: repl }); return pre + repl + post; }
    }
    return tok;
  }).join('');
  return { fixed: out, changes };
}

module.exports = { fixTypos, DICT };
