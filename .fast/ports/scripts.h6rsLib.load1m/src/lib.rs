//! Rust port of scripts.h6rsLib.mjs load1m — byte-faithful CSV 1-min loader.
use napi_derive::napi;

#[napi(object)]
pub struct Bar {
  pub date: String,
  pub time: String,
  pub o: f64,
  pub h: f64,
  pub l: f64,
  pub c: f64,
  pub v: f64,
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
  // Number(str): "" -> 0; invalid -> NaN
  let t = s.trim();
  if t.is_empty() { return 0.0; }
  t.parse::<f64>().unwrap_or(f64::NAN)
}

#[napi(js_name = "load1m", catch_unwind)]
pub fn load1m(sym: String, root: Option<String>) -> napi::Result<Vec<Bar>> {
  let root = root.unwrap_or_else(|| "/Users/himanshuvaghela/Downloads/NSE DERIVATIVES".to_string());
  let file = std::path::Path::new(&root).join(format!("{}-EQ", sym)).join(format!("{}-EQ1.csv", sym));
  let data = std::fs::read(&file).map_err(|e| napi::Error::from_reason(format!("{}", e)))?;

  let mut bars: Vec<Bar> = Vec::with_capacity(1 << 16);
  let mut start = 0usize;
  let mut i = 0usize;
  while i <= data.len() {
    if i == data.len() || data[i] == b'\n' {
      let mut line = &data[start..i];
      if line.last() == Some(&b'\r') { line = &line[..line.len() - 1]; }
      if !line.is_empty() {
        let mut fields = line.split(|&b| b == b',');
        // exactly 7 fields: collect and count
        let f: Vec<&[u8]> = fields.by_ref().collect();
        if f.len() == 7 && date_ok(f[0]) && time_ok(f[1]) {
          let mins = (f[1][0] - b'0') as i32 * 600 + (f[1][1] - b'0') as i32 * 60
            + (f[1][3] - b'0') as i32 * 10 + (f[1][4] - b'0') as i32;
          if (555..=930).contains(&mins) {
            let date_s = String::from_utf8_lossy(f[0]);
            let time_s = String::from_utf8_lossy(f[1]);
            let o = js_plus(&String::from_utf8_lossy(f[2]));
            let h = js_plus(&String::from_utf8_lossy(f[3]));
            let l = js_plus(&String::from_utf8_lossy(f[4]));
            let c = js_plus(&String::from_utf8_lossy(f[5]));
            let vv = js_plus(&String::from_utf8_lossy(f[6]));
            // JS `+v || 0`: falsy (0, -0, NaN, "", undefined) -> 0
            let v = if vv == 0.0 || vv.is_nan() { 0.0 } else { vv };
            bars.push(Bar { date: date_s.replace('.', "-"), time: time_s.into_owned(), o, h, l, c, v });
          }
        }
      }
      start = i + 1;
    }
    i += 1;
  }
  Ok(bars)
}
