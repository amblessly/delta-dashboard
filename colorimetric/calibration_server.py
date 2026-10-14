"""calibration_server.py — HTTP server for colorimetric calibration interface.

Provides REST API for managing calibration data (Sodium + Lactate):
capture, view, add, edit, delete, export, import calibration points.

Port: 8003
"""
import json
import time
import os
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

# Ensure colorimetric package is importable
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from colorimetric.calibration import CalibrationManager, CalibrationPoint, Baseline
from colorimetric.camera import create_camera
from colorimetric.strip_detector import StripDetector
from colorimetric.color_analysis import extract_roi_color
from colorimetric.bcg_classifier import classify_bcg_simple

PORT = 8003
CONFIG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config")
CAL_FILE = os.path.join(CONFIG_DIR, "calibration.json")

camera = create_camera()
detector = StripDetector()
cal_mgr = CalibrationManager(CAL_FILE)


class CalHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)

        if path == "/":
            self._serve_html()
        elif path == "/api/summary":
            self._json_response(cal_mgr.summary())
        elif path == "/api/calibration":
            analyte = params.get("analyte", ["sodium"])[0]
            ds = cal_mgr.get_dataset(analyte)
            if ds:
                self._json_response({"analyte": analyte, "points": ds.to_list()})
            else:
                self._json_response({"error": "Unknown analyte"}, 400)
        elif path == "/api/baseline":
            analyte = params.get("analyte", ["sodium"])[0]
            ds = cal_mgr.get_dataset(analyte)
            if ds:
                self._json_response({"analyte": analyte, "baseline": ds.baseline.to_dict()})
            else:
                self._json_response({"error": "Unknown analyte"}, 400)
        elif path == "/api/capture":
            self._capture_for_calibration()
        elif path == "/api/validate":
            self._json_response(cal_mgr.validate_all())
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        content_len = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(content_len)) if content_len > 0 else {}

        if path == "/api/add":
            self._add_point(body)
        elif path == "/api/update":
            self._update_point(body)
        elif path == "/api/delete":
            self._delete_point(body)
        elif path == "/api/import":
            self._import_data(body)
        elif path == "/api/capture_and_classify":
            self._capture_and_classify(body)
        elif path == "/api/baseline/capture":
            self._capture_baseline(body)
        elif path == "/api/baseline/reset":
            self._reset_baseline(body)
        elif path == "/api/lock":
            self._lock_calibration()
        elif path == "/api/unlock":
            self._unlock_calibration()
        else:
            self.send_response(404)
            self.end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _json_response(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _capture_for_calibration(self):
        """Capture a frame and return current strip detection + color."""
        try:
            if not camera.is_started:
                camera.start()
            frame = camera.capture_single()
            if frame is None:
                self._json_response({"error": "No frame captured"}, 500)
                return

            import cv2
            bgr = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR) if len(frame.shape) == 3 else frame
            detection = detector.detect(bgr)
            color = None
            bcg_state = "UNKNOWN"

            if detection["detected"] and detection["reaction_roi"]:
                roi = detection["reaction_roi"]
                color = extract_roi_color(bgr, roi, detection.get("reaction_mask"))
                if color:
                    bcg_state, _ = classify_bcg_simple(color["rgb"], color["hsv"])

            self._json_response({
                "detected": detection["detected"],
                "roi": detection["reaction_roi"],
                "color": color,
                "bcg_state": bcg_state,
            })
        except Exception as e:
            self._json_response({"error": str(e)}, 500)

    def _capture_and_classify(self, body):
        """Capture frame and classify with a specified analyte's calibration."""
        analyte = body.get("analyte", "sodium")
        ds = cal_mgr.get_dataset(analyte)

        try:
            if not camera.is_started:
                camera.start()
            frame = camera.capture_single()
            if frame is None:
                self._json_response({"error": "No frame captured"}, 500)
                return

            import cv2
            bgr = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR) if len(frame.shape) == 3 else frame
            detection = detector.detect(bgr)
            color = None
            bcg_state = "UNKNOWN"
            nearest_pct = None

            if detection["detected"] and detection["reaction_roi"]:
                roi = detection["reaction_roi"]
                color = extract_roi_color(bgr, roi, detection.get("reaction_mask"))
                if color and ds:
                    bcg_state, _ = classify_bcg_simple(color["rgb"], color["hsv"])
                    idx, point, dist = ds.find_closest(color["rgb"], color["hsv"])
                    if point:
                        nearest_pct = point.percentage

            self._json_response({
                "detected": detection["detected"],
                "color": color,
                "bcg_state": bcg_state,
                "nearest_cal_point_pct": nearest_pct,
                "analyte": analyte,
            })
        except Exception as e:
            self._json_response({"error": str(e)}, 500)

    def _add_point(self, body):
        try:
            point = CalibrationPoint(
                percentage=body["percentage"],
                rgb=body["rgb"],
                hsv=body["hsv"],
                color_state=body.get("color_state", "UNKNOWN"),
                concentration=body.get("concentration"),
            )
            analyte = body.get("analyte", "sodium")
            ds = cal_mgr.get_dataset(analyte)
            if ds is None:
                self._json_response({"error": "Unknown analyte"}, 400)
                return
            ds.add_point(point)
            cal_mgr.save()
            self._json_response({"ok": True, "summary": cal_mgr.summary()})
        except Exception as e:
            self._json_response({"error": str(e)}, 400)

    def _update_point(self, body):
        try:
            analyte = body.get("analyte", "sodium")
            index = body.get("index")
            ds = cal_mgr.get_dataset(analyte)
            if ds is None or index is None:
                self._json_response({"error": "Invalid request"}, 400)
                return
            point = CalibrationPoint(
                percentage=body["percentage"],
                rgb=body["rgb"],
                hsv=body["hsv"],
                color_state=body.get("color_state", "UNKNOWN"),
                concentration=body.get("concentration"),
            )
            ds.update_point(index, point)
            cal_mgr.save()
            self._json_response({"ok": True, "summary": cal_mgr.summary()})
        except Exception as e:
            self._json_response({"error": str(e)}, 400)

    def _delete_point(self, body):
        try:
            analyte = body.get("analyte", "sodium")
            index = body.get("index")
            ds = cal_mgr.get_dataset(analyte)
            if ds is None or index is None:
                self._json_response({"error": "Invalid request"}, 400)
                return
            ds.remove_point(index)
            cal_mgr.save()
            self._json_response({"ok": True, "summary": cal_mgr.summary()})
        except Exception as e:
            self._json_response({"error": str(e)}, 400)

    def _import_data(self, body):
        try:
            data = body.get("data", {})
            if "sodium" in data:
                cal_mgr.sodium = cal_mgr.sodium.__class__.from_list(
                    "sodium", data["sodium"])
            if "lactate" in data:
                cal_mgr.lactate = cal_mgr.lactate.__class__.from_list(
                    "lactate", data["lactate"])
            cal_mgr.save()
            self._json_response({"ok": True, "summary": cal_mgr.summary()})
        except Exception as e:
            self._json_response({"error": str(e)}, 400)

    def _capture_baseline(self, body):
        """Capture baseline for one analyte from multiple frames."""
        analyte = body.get("analyte", "sodium")
        num_frames = min(int(body.get("num_frames", 8)), 20)
        ds = cal_mgr.get_dataset(analyte)
        if ds is None:
            self._json_response({"error": "Unknown analyte"}, 400)
            return

        try:
            if not camera.is_started:
                camera.start()

            import cv2
            frames = []
            for _ in range(num_frames):
                frame = camera.capture_single()
                if frame is None:
                    continue
                bgr = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR) if len(frame.shape) == 3 else frame
                frames.append(bgr)

            if len(frames) < 2:
                self._json_response({"error": "Insufficient frames captured"}, 500)
                return

            # Detect strip in first frame to get ROI
            detection = detector.detect(frames[0])
            if not detection["detected"] or not detection["reaction_roi"]:
                self._json_response({"error": "No strip detected — insert baseline strip"})
                return

            roi = detection["reaction_roi"]
            result = ds.baseline.capture_from_frames(frames, roi, detection.get("reaction_mask"))

            if result["valid"]:
                cal_mgr.version += 1
                ds.baseline.calibration_version = cal_mgr.version
                cal_mgr.save()
                self._json_response({"ok": True, "baseline": ds.baseline.to_dict()})
            else:
                self._json_response({"error": result["message"]}, 400)

        except Exception as e:
            self._json_response({"error": str(e)}, 500)

    def _reset_baseline(self, body):
        """Reset baseline for one analyte without affecting the other."""
        analyte = body.get("analyte", "sodium")
        if analyte not in ("sodium", "lactate"):
            self._json_response({"error": "Unknown analyte"}, 400)
            return
        cal_mgr.reset_baseline(analyte)
        self._json_response({"ok": True, "summary": cal_mgr.summary()})

    def _lock_calibration(self):
        cal_mgr.lock_calibration()
        self._json_response({"ok": True, "summary": cal_mgr.summary()})

    def _unlock_calibration(self):
        cal_mgr.unlock_calibration()
        self._json_response({"ok": True, "summary": cal_mgr.summary()})

    def _serve_html(self):
        html = _CALIBRATION_HTML
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(html.encode())

    def log_message(self, fmt, *args):
        pass


_CALIBRATION_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DELTA Colorimetric Calibration</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Cascadia Code',monospace;background:#0a0e17;color:#e0e0e0;padding:20px}
h1{color:#00e5ff;font-size:1.4em;margin-bottom:16px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.panel{background:#111827;border:1px solid #1e3a5f;border-radius:8px;padding:16px}
.panel h2{color:#00e5ff;font-size:1.1em;margin-bottom:12px}
label{display:block;margin:8px 0 4px;color:#8899aa;font-size:.85em}
input,select,button{width:100%;padding:8px;margin:2px 0;border:1px solid #1e3a5f;border-radius:4px;background:#0a0e17;color:#e0e0e0;font-family:inherit}
button{cursor:pointer;border-color:#00e5ff;color:#00e5ff;margin-top:8px}
button:hover{background:#00e5ff20}
button.danger{border-color:#ff4444;color:#ff4444}
button.lock{border-color:#ffaa00;color:#ffaa00}
button.locked{border-color:#00ff88;color:#00ff88}
table{width:100%;border-collapse:collapse;margin-top:12px;font-size:.85em}
th,td{padding:6px 8px;border:1px solid #1e3a5f;text-align:left}
th{background:#111827;color:#00e5ff}
.val{color:#00e5ff;font-weight:bold}
#status{margin-top:12px;padding:8px;border-radius:4px;background:#111827;font-size:.9em}
.ok{color:#00ff88}.err{color:#ff4444}.warn{color:#ffaa00}
.baseline-box{background:#0a1a2a;border:1px solid #1e3a5f;border-radius:6px;padding:12px;margin:8px 0}
.baseline-box h3{color:#00e5ff;font-size:.95em;margin-bottom:8px}
.baseline-info{font-size:.85em;line-height:1.6}
.lock-status{padding:6px 12px;border-radius:4px;font-size:.85em;margin-bottom:12px}
.lock-status.locked{background:#00ff8820;border:1px solid #00ff88}
.lock-status.unlocked{background:#ffaa0020;border:1px solid #ffaa00}
</style>
</head>
<body>
<h1>DELTA COLORIMETRIC CALIBRATION</h1>
<div class="grid">
<div class="panel">
<h2>LOCK STATUS</h2>
<div id="lockStatus" class="lock-status unlocked">Loading...</div>
<button id="lockBtn" class="lock" onclick="toggleLock()">LOCK CALIBRATION</button>
<hr style="border-color:#1e3a5f;margin:16px 0">
<h2>BASELINE STATUS</h2>
<div id="baselineStatus" class="baseline-info"></div>
<hr style="border-color:#1e3a5f;margin:12px 0">
<h2>CAPTURE SODIUM BASELINE</h2>
<div style="font-size:.85em;color:#8899aa;margin-bottom:8px">Insert BLUE reference strip for Sodium (50% reference). Multi-frame capture validates stability.</div>
<button onclick="captureBaseline('sodium')">CAPTURE SODIUM BASELINE</button>
<div id="sodiumBaselineResult" class="baseline-info" style="margin-top:8px"></div>
<button class="danger" onclick="resetBaseline('sodium')">RESET SODIUM BASELINE</button>
<hr style="border-color:#1e3a5f;margin:16px 0">
<h2>CAPTURE LACTATE BASELINE</h2>
<div style="font-size:.85em;color:#8899aa;margin-bottom:8px">Insert BLUE reference strip for Lactate (50% reference). Must be independently captured.</div>
<button onclick="captureBaseline('lactate')">CAPTURE LACTATE BASELINE</button>
<div id="lactateBaselineResult" class="baseline-info" style="margin-top:8px"></div>
<button class="danger" onclick="resetBaseline('lactate')">RESET LACTATE BASELINE</button>
<hr style="border-color:#1e3a5f;margin:16px 0">
<h2>CAPTURE & CLASSIFY</h2>
<label>Analyte</label>
<select id="analyte"><option value="sodium">Sodium</option><option value="lactate">Lactate</option></select>
<button onclick="captureAndClassify()">CAPTURE STRIP</button>
<div id="captureResult" style="margin-top:12px;font-size:.85em"></div>
<hr style="border-color:#1e3a5f;margin:16px 0">
<h2>ADD CALIBRATION POINT</h2>
<label>Known Percentage (%)</label><input type="number" id="calPct" step="0.1" min="50" max="100">
<label>Concentration (optional)</label><input type="text" id="calConc">
<label>BCG Color State</label>
<select id="calState"><option>BLUE</option><option>BLUE-GREEN</option><option>GREEN</option><option>YELLOW-GREEN</option><option>YELLOW</option><option>PALE</option></select>
<button onclick="addCalPoint()">SAVE CALIBRATION POINT</button>
</div>
<div class="panel">
<h2>CALIBRATION DATA</h2>
<table id="calTable"><thead><tr><th>#</th><th>%</th><th>RGB</th><th>HSV</th><th>Lab</th><th>State</th><th></th></tr></thead><tbody></tbody></table>
<hr style="border-color:#1e3a5f;margin:16px 0">
<h2>EXPORT / IMPORT</h2>
<button onclick="exportCal()">EXPORT JSON</button>
<button onclick="document.getElementById('importInput').click()">IMPORT JSON</button>
<input type="file" id="importInput" accept=".json" style="display:none" onchange="importCal(event)">
<hr style="border-color:#1e3a5f;margin:16px 0">
<h2>VALIDATE CALIBRATION</h2>
<button onclick="validateCal()">RUN VALIDATION</button>
<div id="valResult" style="margin-top:8px;font-size:.85em;white-space:pre-wrap"></div>
<div id="status"></div>
</div>
</div>
<script>
let lastCapture=null;
async function captureBaseline(analyte){
  const el=document.getElementById(analyte+'BaselineResult');
  el.innerHTML='<span style="color:#8899aa">Capturing 8 frames...</span>';
  try{
    const r=await fetch('/api/baseline/capture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({analyte,num_frames:8})});
    const d=await r.json();
    if(d.ok){
      const b=d.baseline;
      el.innerHTML='<div class="baseline-box"><h3>'+analyte.toUpperCase()+' BASELINE — 50%</h3>'+
        '<div>RGB: <span class="val">R: '+b.rgb[0].toFixed(1)+' G: '+b.rgb[1].toFixed(1)+' B: '+b.rgb[2].toFixed(1)+'</span></div>'+
        '<div>HSV: <span class="val">H: '+b.hsv[0].toFixed(1)+' S: '+b.hsv[1].toFixed(1)+' V: '+b.hsv[2].toFixed(1)+'</span></div>'+
        '<div>BCG State: <span class="val">'+b.color_state+'</span></div>'+
        '<div>Frames: <span class="val">'+b.frame_count+'</span> | Variance: <span class="val">'+b.frame_variance.toFixed(3)+'</span></div>'+
        '<div>Calibration Version: <span class="val">v'+b.calibration_version+'</span></div></div>';
      loadBaselineStatus();
    } else {
      el.innerHTML='<span class="err">BASELINE CAPTURE FAILED: '+d.error+'</span>';
    }
  }catch(e){el.innerHTML='<span class="err">Error: '+e.message+'</span>';}
}
async function resetBaseline(analyte){
  if(!confirm('Reset '+analyte.toUpperCase()+' baseline? This will not affect the other analyte.'))return;
  await fetch('/api/baseline/reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({analyte})});
  document.getElementById(analyte+'BaselineResult').innerHTML='<span style="color:#8899aa">'+analyte.toUpperCase()+' BASELINE: NOT SET</span>';
  loadBaselineStatus();
}
async function loadBaselineStatus(){
  let html='';
  for(const a of ['sodium','lactate']){
    const r=await fetch('/api/baseline?analyte='+a);const d=await r.json();
    const b=d.baseline;
    html+='<div class="baseline-box"><h3>'+a.toUpperCase()+' BASELINE</h3>';
    if(b.is_set){
      html+='<div>Status: <span class="ok">SET</span></div>';
      html+='<div>RGB: <span class="val">'+b.rgb.map(v=>v.toFixed(1)).join(', ')+'</span></div>';
      html+='<div>HSV: <span class="val">'+b.hsv.map(v=>v.toFixed(1)).join(', ')+'</span></div>';
      html+='<div>BCG State: <span class="val">'+b.color_state+'</span></div>';
      html+='<div>Frames: '+b.frame_count+' | Variance: '+b.frame_variance.toFixed(3)+'</div>';
      html+='<div>Version: v'+b.calibration_version+'</div>';
    } else {
      html+='<div>Status: <span class="err">NOT SET</span></div>';
      html+='<div style="color:#8899aa">Capture a BLUE reference strip to set baseline.</div>';
    }
    html+='</div>';
  }
  document.getElementById('baselineStatus').innerHTML=html;
}
async function toggleLock(){
  const s=document.getElementById('lockStatus');
  if(s.classList.contains('locked')){
    await fetch('/api/unlock',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  } else {
    if(!confirm('Lock calibration? Normal testing should use locked version.'))return;
    await fetch('/api/lock',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  }
  loadLockStatus();
}
async function loadLockStatus(){
  const r=await fetch('/api/summary');const d=await r.json();
  const el=document.getElementById('lockStatus');
  const btn=document.getElementById('lockBtn');
  if(d.is_locked){
    el.className='lock-status locked';el.innerHTML='LOCKED at v'+d.locked_version;
    btn.className='lock locked';btn.textContent='UNLOCK CALIBRATION';
  } else {
    el.className='lock-status unlocked';el.innerHTML='UNLOCKED (v'+d.version+')';
    btn.className='lock';btn.textContent='LOCK CALIBRATION';
  }
}
async function captureAndClassify(){
  const a=document.getElementById('analyte').value;
  const r=await fetch('/api/capture_and_classify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({analyte:a})});
  const d=await r.json();
  lastCapture=d;
  let html='';
  if(d.error){html='<span class="err">'+d.error+'</span>';}
  else{
    html+='<div>Detected: <span class="val">'+(d.detected?'YES':'NO')+'</span></div>';
    html+='<div>BCG State: <span class="val">'+d.bcg_state+'</span></div>';
    if(d.color){
      html+='<div>RGB: <span class="val">'+d.color.rgb.map(v=>v.toFixed(0)).join(', ')+'</span></div>';
      html+='<div>HSV: <span class="val">'+d.color.hsv.map(v=>v.toFixed(1)).join(', ')+'</span></div>';
      if(d.color.lab) html+='<div>Lab: <span class="val">'+d.color.lab.map(v=>v.toFixed(1)).join(', ')+'</span></div>';
      html+='<div>Coverage: <span class="val">'+(d.color.coverage*100).toFixed(1)+'%</span></div>';
      if(d.color.glare_fraction!=null) html+='<div>Glare: <span class="val">'+(d.color.glare_fraction*100).toFixed(1)+'%</span></div>';
    }
    if(d.nearest_cal_point_pct!=null) html+='<div>Nearest cal: <span class="val">'+d.nearest_cal_point_pct+'%</span></div>';
  }
  document.getElementById('captureResult').innerHTML=html;
}
async function addCalPoint(){
  if(!lastCapture||!lastCapture.color){setStatus('Capture a strip first','err');return;}
  const pct=parseFloat(document.getElementById('calPct').value);
  if(isNaN(pct)||pct<50){setStatus('Enter a valid percentage (>=50%)','err');return;}
  const body={
    analyte:document.getElementById('analyte').value,
    percentage:pct,
    rgb:lastCapture.color.rgb,
    hsv:lastCapture.color.hsv,
    color_state:document.getElementById('calState').value,
    concentration:document.getElementById('calConc').value||null
  };
  const r=await fetch('/api/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const d=await r.json();
  if(d.ok){setStatus('Point added','ok');loadTable();}
  else{setStatus(d.error,'err');}
}
async function loadTable(){
  const a=document.getElementById('analyte').value;
  const r=await fetch('/api/calibration?analyte='+a);
  const d=await r.json();
  const tb=document.querySelector('#calTable tbody');
  tb.innerHTML='';
  (d.points||[]).forEach((p,i)=>{
    const tr=document.createElement('tr');
    const labStr=p.lab?p.lab.map(v=>v.toFixed(0)).join(','):'--';
    tr.innerHTML='<td>'+(i+1)+'</td><td>'+p.percentage+'%</td><td>'+p.rgb.map(v=>v.toFixed(0)).join(',')+'</td><td>'+p.hsv.map(v=>v.toFixed(0)).join(',')+'</td><td>'+labStr+'</td><td>'+p.color_state+'</td><td><button class="danger" onclick="delPoint('+i+')" style="width:auto;padding:2px 8px;margin:0">DEL</button></td>';
    tb.appendChild(tr);
  });
}
async function delPoint(i){
  const a=document.getElementById('analyte').value;
  await fetch('/api/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({analyte:a,index:i})});
  loadTable();
}
function exportCal(){
  fetch('/api/calibration?analyte=sodium').then(r=>r.json()).then(sodium=>{
    fetch('/api/calibration?analyte=lactate').then(r=>r.json()).then(lactate=>{
      fetch('/api/baseline?analyte=sodium').then(r=>r.json()).then(sB=>{
        fetch('/api/baseline?analyte=lactate').then(r=>r.json()).then(lB=>{
          const data={sodium:sodium.points,lactate:lactate.points,sodium_baseline:sB.baseline,lactate_baseline:lB.baseline};
          const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
          const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='calibration.json';a.click();
        });
      });
    });
  });
}
async function importCal(e){
  const file=e.target.files[0];if(!file)return;
  const text=await file.text();
  try{const data=JSON.parse(text);
    const r=await fetch('/api/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data})});
    const d=await r.json();
    if(d.ok){setStatus('Imported','ok');loadTable();loadBaselineStatus();}else{setStatus(d.error,'err');}
  }catch(err){setStatus('Invalid JSON','err');}
}
function setStatus(msg,cls){const el=document.getElementById('status');el.innerHTML='<span class="'+cls+'">'+msg+'</span>';}
async function validateCal(){
  const r=await fetch('/api/validate');const d=await r.json();
  let html='';
  for(const analyte of ['sodium','lactate']){
    const a=d[analyte];
    html+='<b>'+analyte.toUpperCase()+'</b>\\n';
    html+='  Direction: '+(a.direction.valid?'OK':'INVALID')+' — '+a.direction.message+'\\n';
    html+='  Baseline: '+(a.baseline.valid?'OK':'INVALID')+' — '+a.baseline.message+'\\n';
    if(a.self_test && a.self_test.mae!=null){
      html+='  Self-test MAE: '+a.self_test.mae+'% | RMSE: '+a.self_test.rmse+'% | R²: '+(a.self_test.r_squared!=null?a.self_test.r_squared:'N/A')+' | Bias: '+(a.self_test.bias!=null?a.self_test.bias+'%':'N/A')+' | Quality: '+a.self_test.quality+'\\n';
    }
    if(a.cross_validation && a.cross_validation.mae!=null){
      html+='  Cross-val MAE: '+a.cross_validation.mae+'% | RMSE: '+a.cross_validation.rmse+'% | R²: '+(a.cross_validation.r_squared!=null?a.cross_validation.r_squared:'N/A')+' | Bias: '+(a.cross_validation.bias!=null?a.cross_validation.bias+'%':'N/A')+'\\n';
      for(const p of a.cross_validation.points){
        html+='    '+p.held_out_pct+'% → predicted '+p.predicted_pct+'% (err '+p.error+'%)\\n';
      }
    } else if(a.cross_validation && a.cross_validation.error){
      html+='  Cross-val: '+a.cross_validation.error+'\\n';
    }
    html+='\\n';
  }
  document.getElementById('valResult').innerHTML='<pre style="color:#00e5ff">'+html+'</pre>';
}
document.getElementById('analyte').addEventListener('change',loadTable);
loadBaselineStatus();
loadLockStatus();
loadTable();
</script>
</body></html>"""


def main():
    print(f"[calibration] Starting calibration server on port {PORT}...")
    camera.start()
    server = HTTPServer(("0.0.0.0", PORT), CalHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        camera.stop()
        server.server_close()
        print("[calibration] Server stopped.")


if __name__ == "__main__":
    main()
