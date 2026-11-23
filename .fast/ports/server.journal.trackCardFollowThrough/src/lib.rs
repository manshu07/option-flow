//! Rust port of server/journal.mjs trackCardFollowThrough — byte-faithful over serde_json values.
//! Verified by scripts/journalPortVerify.mjs replaying every stored card against the archive.
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::{json, Value};

const MINUTE_MS: i64 = 60_000;
const IST_OFFSET_MS: i64 = 330 * 60_000;
const CAS_EFFECTIVE: &str = "2026-08-03";

// Date.parse("YYYY-MM-DDTHH:MM:SS+05:30") — civil-days algorithm (Howard Hinnant).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
  let y = if m <= 2 { y - 1 } else { y };
  let era = if y >= 0 { y } else { y - 399 } / 400;
  let yoe = y - era * 400;
  let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
  let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  era * 146097 + doe - 719468
}
fn parse_ist(date: &str, hh: i64, mi: i64, ss: i64) -> i64 {
  let y: i64 = date[0..4].parse().unwrap_or(0);
  let m: i64 = date[5..7].parse().unwrap_or(0);
  let d: i64 = date[8..10].parse().unwrap_or(0);
  (days_from_civil(y, m, d) * 86_400 + hh * 3_600 + mi * 60 + ss) * 1_000 - IST_OFFSET_MS
}
fn ist_parts(t: i64) -> (String, i64, i64, i64) {
  let ist = t + IST_OFFSET_MS;
  let secs = ist.div_euclid(1_000);
  let days = secs.div_euclid(86_400);
  let sod = secs.rem_euclid(86_400);
  // inverse civil
  let z = days + 719_468;
  let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
  let doe = z - era * 146_097;
  let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
  let y = yoe + era * 400;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let d = doy - (153 * mp + 2) / 5 + 1;
  let m = if mp < 10 { mp + 3 } else { mp - 9 };
  let y = if m <= 2 { y + 1 } else { y };
  let date_key = format!("{:04}-{:02}-{:02}", y, m, d);
  (date_key, sod / 3_600, (sod % 3_600) / 60, sod % 60)
}
fn session_close_at(date: &str) -> Option<i64> {
  let b = date.as_bytes();
  let valid = b.len() == 10 && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() });
  if !valid { return None; }
  let close_minute = if date >= CAS_EFFECTIVE { 15 * 60 + 40 } else { 15 * 60 + 30 };
  Some(parse_ist(date, close_minute / 60, close_minute % 60, 0))
}
fn js_finite(v: &Value) -> bool { v.as_f64().map(|f| f.is_finite()).unwrap_or(false) }
fn is_safe_integer(v: &Value) -> bool {
  v.as_i64().map(|i| (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&i)).unwrap_or(false)
    && v.is_number() && v.as_f64().map(|f| f.fract() == 0.0 && f.is_finite()).unwrap_or(false)
}
fn round2(v: f64) -> f64 { (v * 100.0).round() / 100.0 }

#[napi(js_name = "trackCardFollowThrough", catch_unwind)]
pub fn track_card_follow_through(card: Value, minutes_json: String, source: Option<String>, futures_candles_json: Option<String>) -> Result<Value> {
  // Minutes arrive as one JSON string: a single napi boundary value, parsed here.
  let minutes: Value = serde_json::from_str(&minutes_json).map_err(|e| napi::Error::from_reason(format!("minutes parse: {e}")))?;
  let futures_candles = futures_candles_json.as_deref().and_then(|json| serde_json::from_str::<Value>(json).ok());
  // validCard
  let ok_shape = card.is_object()
    && card.get("date").and_then(|v| v.as_str()).map(|s| {
      let bytes = s.as_bytes();
      bytes.len() == 10 && bytes.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() })
    }).unwrap_or(false)
    && card.get("symbol").map(|v| v.is_string()).unwrap_or(false)
    && js_finite(card.get("at").unwrap_or(&Value::Null))
    && js_finite(card.get("strike").unwrap_or(&Value::Null))
    && matches!(card.get("side").and_then(|v| v.as_str()), Some("CE") | Some("PE"))
    && js_finite(card.get("entry").unwrap_or(&Value::Null))
    && js_finite(card.get("sl").unwrap_or(&Value::Null))
    && js_finite(card.get("tgt1").unwrap_or(&Value::Null))
    && js_finite(card.get("tgt2").unwrap_or(&Value::Null));
  if !ok_shape { return Ok(Value::Null); }
  let entry = card["entry"].as_f64().unwrap();
  let sl = card["sl"].as_f64().unwrap();
  let tgt1 = card["tgt1"].as_f64().unwrap();
  let tgt2 = card["tgt2"].as_f64().unwrap();
  if !(sl > 0.0 && sl < entry && tgt1 > entry && tgt2 >= tgt1) { return Ok(Value::Null); }
  let date = card["date"].as_str().unwrap().to_string();
  let card_at = card["at"].as_f64().unwrap();
  let close_at = match session_close_at(&date) { Some(v) => v, None => return Ok(Value::Null) };
  let open_at = parse_ist(&date, 9, 15, 0);
  if !(card_at >= open_at as f64 && card_at < (close_at + MINUTE_MS) as f64) { return Ok(Value::Null); }
  // belongsToDate({date: card.date, t: card.at}, card.date): same date string + marketParts(t).dateKey === date + t finite
  let t_ok = { let t = card["at"].as_f64().unwrap(); let (key, _, _, _) = ist_parts(t as i64); t.is_finite() && key == date };
  if !t_ok { return Ok(Value::Null); }

  let expected_minutes = ((close_at / MINUTE_MS) - (card_at as i64 / MINUTE_MS) + 1) as f64;
  let side_code = if card["side"] == json!("CE") { 0i64 } else { 1i64 };
  let expiry = card.get("expiry").and_then(|v| v.as_str()).map(|s| s.to_string());
  let symbol = card["symbol"].as_str().unwrap().to_string();
  let strike = card["strike"].as_f64().unwrap();

  struct Rec { at: i64, premium: f64, high: Option<f64>, low: Option<f64> }
  let mut records: Vec<Rec> = Vec::new();
  if let Some(arr) = minutes.as_array() {
    for snapshot in arr {
      if !snapshot.is_object() { continue; }
      let st = snapshot.get("t").and_then(|v| v.as_f64());
      let sdate = snapshot.get("date");
      let st = match st { Some(v) if v.is_finite() => v, _ => continue };
      let mut bd = false;
      if let Some(sd) = sdate.and_then(|v| v.as_str()) {
        if sd == date { let (key, _, _, _) = ist_parts(st as i64); bd = key == date; }
      }
      if !bd || st < open_at as f64 || st >= (close_at + MINUTE_MS) as f64 { continue; }
      let series_list = snapshot.get("series").and_then(|v| v.as_array());
      let series = series_list.and_then(|list| list.iter().find(|item| item.get("s").and_then(|v| v.as_str()) == Some(symbol.as_str())));
      let series = match series { Some(s) if s.is_object() => s, _ => continue };
      let on_near = match &expiry { Some(e) => series.get("e").and_then(|v| v.as_str()) == Some(e.as_str()), None => false };
      let on_next = match &expiry { Some(e) => series.get("next").and_then(|n| n.get("e").and_then(|v| v.as_str())) == Some(e.as_str()), None => false };
      if !on_near && !on_next { continue; }
      let rows = if on_next { series.get("next").and_then(|n| n.get("r")).and_then(|v| v.as_array()) } else { series.get("r").and_then(|v| v.as_array()) };
      let row = rows.and_then(|list| list.iter().find(|item| {
        item.as_array().map(|r| r.get(0).and_then(|v| v.as_f64()) == Some(strike) && r.get(1).and_then(|v| v.as_i64()) == Some(side_code)).unwrap_or(false)
      }));
      let row = match row.and_then(|r| r.as_array()) { Some(r) => r, None => continue };
      if row.len() <= 15 { continue; }
      let premium = match row.get(2).and_then(|v| v.as_f64()) { Some(p) if p.is_finite() && p > 0.0 => p, _ => continue };
      let at = match series.get("t").and_then(|v| v.as_f64()) { Some(v) if v.is_finite() => v as i64, _ => st as i64 };
      if (at as f64) < open_at as f64 || (at as f64) > st || at >= close_at + MINUTE_MS { continue; }
      let high = row.get(14).and_then(|v| v.as_f64()).filter(|v| v.is_finite() && *v >= premium);
      let low = row.get(15).and_then(|v| v.as_f64()).filter(|v| v.is_finite() && *v > 0.0 && *v <= premium);
      records.push(Rec { at, premium, high, low });
    }
  }
  records.sort_by_key(|r| r.at);

  let mut previous_high: Option<(f64, i64)> = None;
  let mut previous_low: Option<(f64, i64)> = None;
  let mut first_at: Option<i64> = None;
  let mut last_at: Option<i64> = None;
  let mut range_open: Option<f64> = None;
  let mut range_high: Option<f64> = None;
  let mut range_low: Option<f64> = None;
  let mut range_close: Option<f64> = None;
  let mut touch_sl: Option<Value> = None;
  let mut touch_t1: Option<Value> = None;
  let mut touch_t2: Option<Value> = None;
  let mut observed: std::collections::HashSet<i64> = std::collections::HashSet::new();
  let card_at_i = card_at as i64;
  for r in &records {
    let premium = r.premium;
    let high = r.high;
    let low = r.low;
    if (r.at as f64) >= card_at {
      observed.insert(r.at.div_euclid(MINUTE_MS));
      if first_at.is_none() { first_at = Some(r.at); range_open = Some(premium); }
      last_at = Some(r.at);
      range_close = Some(premium);
      range_high = Some(range_high.map_or(premium, |v: f64| v.max(premium)));
      range_low = Some(range_low.map_or(premium, |v: f64| v.min(premium)));
      let new_high = match (high, previous_high) {
        (Some(hv), Some((pv, pat))) => pat >= card_at_i && (pat as f64) < r.at as f64 && hv > pv,
        _ => false,
      };
      let new_low = match (low, previous_low) {
        (Some(lv), Some((pv, pat))) => pat >= card_at_i && (pat as f64) < r.at as f64 && lv < pv,
        _ => false,
      };
      if new_high { range_high = Some(range_high.unwrap().max(high.unwrap())); }
      if new_low { range_low = Some(range_low.unwrap().min(low.unwrap())); }
      let mut try_touch = |cur: &mut Option<Value>, level: f64, is_sl: bool| {
        if cur.is_some() { return; }
        let quote_hit = if is_sl { premium <= level } else { premium >= level };
        let range_hit = if is_sl {
          match (new_low, low, previous_low) { (true, Some(lv), Some((_, pat))) => lv <= level && { let _ = pat; true }, _ => false }
        } else {
          match (new_high, high, previous_high) { (true, Some(hv), Some((_, pat))) => hv >= level && { let _ = pat; true }, _ => false }
        };
        if quote_hit || range_hit {
          let after = if quote_hit { r.at } else if is_sl { previous_low.map(|p| p.1).unwrap_or(r.at) } else { previous_high.map(|p| p.1).unwrap_or(r.at) };
          *cur = Some(json!({ "at": r.at, "after": after, "source": if quote_hit { "ltp" } else { "day-range" } }));
        }
      };
      try_touch(&mut touch_sl, sl, true);
      try_touch(&mut touch_t1, tgt1, false);
      try_touch(&mut touch_t2, tgt2, false);
    }
    if let Some(hv) = high { previous_high = Some((hv, r.at)); }
    if let Some(lv) = low { previous_low = Some((lv, r.at)); }
  }

  let target = touch_t1.clone().or_else(|| touch_t2.clone());
  let stop = touch_sl.clone();
  let mut sequence = "none-observed".to_string();
  let before = |first: &Value, next: &Value| -> bool {
    if next["source"] == json!("day-range") { first["at"].as_f64().unwrap() <= next["after"].as_f64().unwrap() } else { first["at"].as_f64().unwrap() < next["after"].as_f64().unwrap() }
  };
  if let (Some(st), Some(tg)) = (&stop, &target) {
    sequence = if before(st, tg) { "sl-first".into() } else if before(tg, st) { "target-first".into() } else { "ambiguous".into() };
  } else if stop.is_some() { sequence = "sl-first".into(); }
  else if target.is_some() { sequence = "target-first".into(); }

  let sample_count = observed.len();
  let missing = ((expected_minutes as i64) - sample_count as i64).max(0);
  let first_full_minute = (card_at / MINUTE_MS as f64).ceil() as i64 * MINUTE_MS;
  let mut f_high = f64::NEG_INFINITY; let mut f_low = f64::INFINITY;
  let mut f_from = i64::MAX; let mut f_to = i64::MIN; let mut f_n = 0i64;
  if let Some(arr) = futures_candles.as_ref().and_then(|v| v.as_array()) {
    for candle in arr {
      let at = candle.get("at").and_then(|v| v.as_i64());
      let high = candle.get("high").and_then(|v| v.as_f64());
      let low = candle.get("low").and_then(|v| v.as_f64());
      let ok = is_safe_integer(candle.get("at").unwrap_or(&Value::Null))
        && at.map(|a| a % MINUTE_MS == 0).unwrap_or(false)
        && at.map(|a| a >= first_full_minute && a + MINUTE_MS <= close_at).unwrap_or(false)
        && high.map(|h| h.is_finite()).unwrap_or(false)
        && low.map(|l| l.is_finite() && l > 0.0).unwrap_or(false)
        && high.zip(low).map(|(h, l)| h >= l).unwrap_or(false);
      if let (Some(a), Some(h), Some(l)) = (at, high, low) {
        if ok { f_high = f_high.max(h); f_low = f_low.min(l); f_from = f_from.min(a); f_to = f_to.max(a + MINUTE_MS); f_n += 1; }
      }
    }
  }
  let futures = if f_n > 0 { json!({ "high": f_high, "low": f_low, "from": f_from, "to": f_to }) } else { Value::Null };

  let rng = |v: Option<f64>| v.map(round2).map(|x| json!(x)).unwrap_or(Value::Null);
  Ok(json!({
    "version": 1,
    "source": source.unwrap_or_else(|| "raw".to_string()),
    "from": card_at,
    "sessionCloseAt": close_at,
    "firstAt": first_at.map(|v| json!(v)).unwrap_or(Value::Null),
    "lastAt": last_at.map(|v| json!(v)).unwrap_or(Value::Null),
    "sampleCount": sample_count,
    "expectedMinutes": expected_minutes,
    "missingMinutes": missing,
    "coverage": if sample_count == 0 { "missing" } else if missing > 0 { "partial" } else { "complete" },
    "range": { "open": rng(range_open), "high": rng(range_high), "low": rng(range_low), "close": rng(range_close) },
    "touches": { "sl": touch_sl.unwrap_or(Value::Null), "tgt1": touch_t1.unwrap_or(Value::Null), "tgt2": touch_t2.unwrap_or(Value::Null) },
    "sequence": sequence,
    "futures": futures,
  }))
}
