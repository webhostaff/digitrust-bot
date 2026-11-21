'use strict';
/**
 * Binance "Off-chain transfer" ids (V146).
 *
 * A transfer from one Binance account to another never touches a blockchain, so it has no hash.
 * Binance shows it as  Txid: "Off-chain Transfer 418351948005"  and stores it the same way in the
 * receiving account's deposit history. A customer may paste any of:
 *      418351948005 · Off-chain Transfer 418351948005 · off-chain transfer: 418351948005
 * They are the SAME transfer, so they must be matched — and counted as used — as one.
 * No dependencies on purpose: the database layer and the Binance layer both use it.
 */

const OFFCHAIN_RE = /^(?:(?:off-?chain|internal)\s*transfer\s*[:#-]?\s*)?(\d{8,20})$/i;
const OFFCHAIN_LABEL = 'Off-chain transfer';           // how Binance spells it: the stored (canonical) form

/** The digits of an off-chain id in any spelling, or null (a blockchain hash is never this). */
function offchainDigits(raw) {
  const m = OFFCHAIN_RE.exec(String(raw == null ? '' : raw).trim());
  return m ? m[1] : null;
}

const isOffchainTxid = (raw) => offchainDigits(raw) !== null;

/** What to store and look up: off-chain ids in Binance's own spelling, everything else untouched. */
function normalizeTxidInput(raw) {
  const v = String(raw == null ? '' : raw).trim();
  const d = offchainDigits(v);
  return d ? `${OFFCHAIN_LABEL} ${d}` : v;
}

/** Every spelling a stored/used id may have (rows saved by older versions use Binance's text as is). */
function txidAlternates(raw) {
  const v = String(raw == null ? '' : raw).trim();
  const d = offchainDigits(v);
  return d ? [`${OFFCHAIN_LABEL} ${d}`, `Internal transfer ${d}`, d] : (v ? [v] : []);
}

module.exports = { OFFCHAIN_RE, OFFCHAIN_LABEL, offchainDigits, isOffchainTxid, normalizeTxidInput, txidAlternates };
