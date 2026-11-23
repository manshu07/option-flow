//! Rust port of scripts.h6rsLib.mjs h6rsCore — parse + resample + RSI in one call.
use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi(object)]
pub struct H6rsCoreResult {
  pub dates: Vec<String>,
  pub day_idx: Int32Array,
  pub mins: Int32Array,
  pub closes: Float64Array,
  pub highs: Float64Array,
  pub lows: Float64Array,
  pub vols: Float64Array,
  pub opens: Float64Array,
  pub osc: Float64Array,
}

fn date_ok(s: &[u8]) -> bool {
  s.len() == 10
    && s[0].is_ascii_digit() && s[1].is_ascii_digit() && s[2].is_ascii_digit() && s[3].is_ascii_digit()
    && s[4] == b'.'
    && s[5].is_ascii_digit() && s[6].is_ascii_digit()
    && s[7] == b'.'
    && s[8].is_ascii_digit() && s[9].is_ascii_digit()
}

fn time_ok(s: &[u8]) -> bool {
  s.len() == 5 && s[0].is_ascii_digit() && s[1].is_ascii_digit() && s[2] == b':' && s[3].is_ascii_digit() && s[4].is_ascii_digit()
}

fn js_plus(s: &str) -> f64 {
  let t = s.trim();
  if t.is_empty() { return 0.0; }
  t.parse::<f64>().unwrap_or(f64::NAN)
}

#[napi(js_name = "h6rsCore", catch_unwind)]
pub fn h6rs_core(sym: String, minutes: i32, rsi_p: i32, root: Option<String>) -> napi::Result<H6rsCoreResult> {
  let root = root.unwrap_or_else(|| "/Users/himanshuvaghela/Downloads/NSE DERIVATIVES".to_string());
  let minutes = minutes as i64;
  let file = std::path::Path::new(&root).join(format!("{}-EQ", sym)).join(format!("{}-EQ1.csv", sym));
  let data = std::fs::read(&file).map_err(|e| napi::Error::from_reason(format!("{}", e)))?;

  // resampled aggregates
  let mut dates: Vec<String> = Vec::with_capacity(4096);
  let mut date_idx: std::collections::HashMap<&[u8], i32> = std::collections::HashMap::new();
  let mut out_day: Vec<i32> = Vec::with_capacity(1 << 14);
  let mut out_mins: Vec<i32> = Vec::with_capacity(1 << 14);
  let mut out_c: Vec<f64> = Vec::with_capacity(1 << 14);
  let mut out_h: Vec<f64> = Vec::with_capacity(1 << 14);
  let mut out_l: Vec<f64> = Vec::with_capacity(1 << 14);
  let mut out_v: Vec<f64> = Vec::with_capacity(1 << 14);
  let mut out_o: Vec<f64> = Vec::with_capacity(1 << 14);
  let mut cur_slot: i64 = -1;
  let mut cur_day: i32 = -1;
  let mut h = 0f64;
  let mut l = 0f64;
  let mut c = 0f64;
  let mut v = 0f64;
  let mut o = 0f64;
  let mut w = 0i64;

  let mut start = 0usize;
  let mut i = 0usize;
  while i <= data.len() {
    if i == data.len() || data[i] == b'\n' {
      let mut line = &data[start..i];
      if line.last() == Some(&b'\r') { line = &line[..line.len() - 1]; }
      if !line.is_empty() {
        let f: Vec<&[u8]> = line.split(|&b| b == b',').collect();
        if f.len() == 7 && date_ok(f[0]) && time_ok(f[1]) {
          let mins = (f[1][0] - b'0') as i64 * 600 + (f[1][1] - b'0') as i64 * 60
            + (f[1][3] - b'0') as i64 * 10 + (f[1][4] - b'0') as i64;
          if (555..=930).contains(&mins) {
            let day = f[0];
            let d = match date_idx.get(day) {
              Some(&d) => d,
              None => { let d = dates.len() as i32; dates.push(String::from_utf8_lossy(day).replace('.', "-")); date_idx.insert(day, d); d }
            };
            let slot = (mins - 555) / minutes;
            if slot != cur_slot || d != cur_day {
              if w > 0 { out_c.push(c); out_h.push(h); out_l.push(l); out_v.push(v); out_o.push(o); out_day.push(cur_day); out_mins.push((cur_slot * minutes + 555) as i32); }
              cur_slot = slot; cur_day = d; h = f64::NEG_INFINITY; l = f64::INFINITY; c = 0.0; v = 0.0; o = 0.0; w = 0;
            }
            if w == 0 { o = js_plus(&String::from_utf8_lossy(f[2])); }
            let hh = js_plus(&String::from_utf8_lossy(f[3]));
            let ll = js_plus(&String::from_utf8_lossy(f[4]));
            h = if hh > h { hh } else { h };
            l = if ll < l { ll } else { l };
            c = js_plus(&String::from_utf8_lossy(f[5]));
            v += js_plus(&String::from_utf8_lossy(f[6]));
            w += 1;
          }
        }
      }
      start = i + 1;
    }
    i += 1;
  }
  if w > 0 { out_c.push(c); out_h.push(h); out_l.push(l); out_v.push(v); out_o.push(o); out_day.push(cur_day); out_mins.push((cur_slot * minutes + 555) as i32); }

  let nc = out_c.len();
  // RSI — byte-identical to scripts/h6rsLib.mjs h6rsCore (Float64Array zero-init, loop from i=1)
  let mut osc = vec![0f64; nc];
  let p = rsi_p as f64;
  let mut g = 0f64;
  let mut lo = 0f64;
  for k in 1..nc {
    let ch = out_c[k] - out_c[k - 1];
    g = (g * (p - 1.0) + ch.max(0.0)) / p;
    lo = (lo * (p - 1.0) + (-ch).max(0.0)) / p;
    osc[k] = if lo == 0.0 { 100.0 } else { 100.0 - 100.0 / (1.0 + g / lo) };
  }

  Ok(H6rsCoreResult {
    dates,
    day_idx: Int32Array::with_data_copied(out_day),
    mins: Int32Array::with_data_copied(out_mins),
    closes: Float64Array::with_data_copied(out_c),
    highs: Float64Array::with_data_copied(out_h),
    lows: Float64Array::with_data_copied(out_l),
    vols: Float64Array::with_data_copied(out_v),
    opens: Float64Array::with_data_copied(out_o),
    osc: Float64Array::with_data_copied(osc),
  })
}
