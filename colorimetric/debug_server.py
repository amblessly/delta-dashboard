"""debug_server.py — Debug HTTP interface for colorimetric analysis.

Shows live camera feed, strip detection, RGB/HSV values, BCG state,
Sodium %, Lactate %, and confidence. Independent from main DELTA UI.

Port: 8004
"""
import json
import time
import os
import sys
import base64
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from colorimetric.camera import create_camera
from colorimetric.strip_detector import StripDetector
from colorimetric.color_analysis import extract_roi_color, analyze_multi_frame
from colorimetric.bcg_classifier import classify_bcg_simple
from colorimetric.calibration import CalibrationManager
from colorimetric import sodium as _na, lactate as _la

PORT = 8004
CONFIG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config")
CAL_FILE = os.path.join(CONFIG_DIR, "calibration.json")

camera = create_camera()
detector = StripDetector()
cal_mgr = CalibrationManager(CAL_FILE)
_lock = threading.Lock()


class DebugHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/":
            self._serve_html()
        elif self.path == "/api/frame":
            self._serve_frame()
        elif self.path == "/api/live":
            self._serve_live_data()
        else:
            self.send_response(404)
            self.end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.end_headers()

    def _json_response(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _serve_frame(self):
        """Return the latest frame as JPEG base64 with analysis overlay."""
        try:
            if not camera.is_started:
                camera.start()
            frame = camera.capture_single()
            if frame is None:
                self._json_response({"error": "No frame"}, 500)
                return

            import cv2
            bgr = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR) if frame.ndim == 3 else frame

            # Detect strip
            detection = detector.detect_dual_zones(bgr)
            annotated = detection.get("annotated", bgr)

            # Encode to JPEG
            _, jpeg = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 80])
            b64 = base64.b64encode(jpeg).decode()

            self._json_response({
                "image": b64,
                "detected": detection["detected"],
                "roi": detection.get("reaction_roi"),
                "sodium_roi": detection.get("sodium_roi"),
                "lactate_roi": detection.get("lactate_roi"),
            })
        except Exception as e:
            self._json_response({"error": str(e)}, 500)

    def _serve_live_data(self):
        """Return full analysis of current frame."""
        try:
            if not camera.is_started:
                camera.start()
            frame = camera.capture_single()
            if frame is None:
                self._json_response({"error": "No frame"}, 500)
                return

            import cv2
            bgr = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR) if frame.ndim == 3 else frame

            detection = detector.detect_dual_zones(bgr)

            result = {
                "detected": detection["detected"],
                "detection_confidence": round(detection["confidence"] * 100, 1),
                "sodium": {"percentage": None, "rgb": None, "hsv": None, "color_state": "N/A", "confidence": 0},
                "lactate": {"percentage": None, "rgb": None, "hsv": None, "color_state": "N/A", "confidence": 0},
            }

            if detection["detected"]:
                # Analyze each zone independently
                mask = detection.get("reaction_mask")

                s_roi = detection.get("sodium_roi") or detection.get("reaction_roi")
                l_roi = detection.get("lactate_roi") or detection.get("reaction_roi")

                if s_roi:
                    s_color = extract_roi_color(bgr, s_roi, mask)
                    if s_color:
                        bcg_s, _ = classify_bcg_simple(s_color["rgb"], s_color["hsv"])
                        s_ds = cal_mgr.get_dataset("sodium")
                        s_pct, s_cf = s_ds.interpolate(s_color["rgb"], s_color["hsv"]) if s_ds else (None, 0)
                        result["sodium"] = {
                            "percentage": s_pct,
                            "rgb": [round(v, 1) for v in s_color["rgb"]],
                            "hsv": [round(v, 1) for v in s_color["hsv"]],
                            "lab": [round(v, 1) for v in s_color.get("lab", [0, 0, 0])],
                            "color_state": bcg_s,
                            "confidence": round(s_cf * 100, 1),
                            "glare_fraction": round(s_color.get("glare_fraction", 0), 3),
                            "color_uniformity": round(s_color.get("color_uniformity", 0), 3),
                            "coverage": round(s_color.get("coverage", 0), 3),
                        }

                if l_roi and l_roi != s_roi:
                    l_color = extract_roi_color(bgr, l_roi, mask)
                    if l_color:
                        bcg_l, _ = classify_bcg_simple(l_color["rgb"], l_color["hsv"])
                        l_ds = cal_mgr.get_dataset("lactate")
                        l_pct, l_cf = l_ds.interpolate(l_color["rgb"], l_color["hsv"]) if l_ds else (None, 0)
                        result["lactate"] = {
                            "percentage": l_pct,
                            "rgb": [round(v, 1) for v in l_color["rgb"]],
                            "hsv": [round(v, 1) for v in l_color["hsv"]],
                            "lab": [round(v, 1) for v in l_color.get("lab", [0, 0, 0])],
                            "color_state": bcg_l,
                            "confidence": round(l_cf * 100, 1),
                            "glare_fraction": round(l_color.get("glare_fraction", 0), 3),
                            "color_uniformity": round(l_color.get("color_uniformity", 0), 3),
                            "coverage": round(l_color.get("coverage", 0), 3),
                        }

            result["baselines"] = {
                "sodium": cal_mgr.sodium.baseline.to_dict(),
                "lactate": cal_mgr.lactate.baseline.to_dict(),
            }

            self._json_response(result)
        except Exception as e:
            self._json_response({"error": str(e)}, 500)

    def _serve_html(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(_DEBUG_HTML.encode())

    def log_message(self, fmt, *args):
        pass


_DEBUG_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DELTA Colorimetric Debug</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Cascadia Code',monospace;background:#0a0e17;color:#e0e0e0;padding:16px}
h1{color:#00e5ff;font-size:1.3em;margin-bottom:12px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.panel{background:#111827;border:1px solid #1e3a5f;border-radius:8px;padding:14px}
.panel h2{color:#00e5ff;font-size:1em;margin-bottom:10px}
.cam{width:100%;border-radius:4px;background:#000;min-height:200px}
.row{display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid #1e3a5f20;font-size:.9em}
.lbl{color:#8899aa}.val{color:#00e5ff;font-weight:bold}
.state{display:inline-block;padding:2px 10px;border-radius:4px;font-weight:bold;margin:4px 0}
.s-blue{background:#0044cc;color:#fff}.s-bluegreen{background:#008866;color:#fff}
.s-green{background:#22aa22;color:#fff}.s-yellowgreen{background:#88aa00;color:#fff}
.s-yellow{background:#ccaa00;color:#000}.s-pale{background:#ddd;color:#333}
.s-unknown{background:#333;color:#888}
.big{font-size:2em;text-align:center;margin:8px 0}
#status{margin-top:8px;font-size:.85em;color:#8899aa}
</style>
</head>
<body>
<h1>DELTA COLORIMETRIC DEBUG</h1>
<div class="grid">
<div class="panel">
<h2>LIVE CAMERA</h2>
<img id="camImg" class="cam" src="" alt="Loading...">
<div id="status">Connecting...</div>
</div>
<div class="panel">
<h2>DETECTION</h2>
<div class="row"><span class="lbl">Strip Detected</span><span class="val" id="detected">--</span></div>
<div class="row"><span class="lbl">Detection Conf</span><span class="val" id="detConf">--</span></div>
<h2 style="margin-top:14px">SODIUM</h2>
<div class="big" id="sodiumPct">--</div>
<div class="row"><span class="lbl">RGB</span><span class="val" id="sRgb">--</span></div>
<div class="row"><span class="lbl">HSV</span><span class="val" id="sHsv">--</span></div>
<div class="row"><span class="lbl">Lab</span><span class="val" id="sLab">--</span></div>
<div class="row"><span class="lbl">BCG Color</span><span id="sBcg" class="state s-unknown">--</span></div>
<div class="row"><span class="lbl">Confidence</span><span class="val" id="sConf">--</span></div>
<div class="row"><span class="lbl">Coverage</span><span class="val" id="sCov">--</span></div>
<div class="row"><span class="lbl">Glare</span><span class="val" id="sGlare">--</span></div>
<div class="row"><span class="lbl">Uniformity</span><span class="val" id="sUnif">--</span></div>
<h2 style="margin-top:14px">LACTATE</h2>
<div class="big" id="lactatePct">--</div>
<div class="row"><span class="lbl">RGB</span><span class="val" id="lRgb">--</span></div>
<div class="row"><span class="lbl">HSV</span><span class="val" id="lHsv">--</span></div>
<div class="row"><span class="lbl">Lab</span><span class="val" id="lLab">--</span></div>
<div class="row"><span class="lbl">BCG Color</span><span id="lBcg" class="state s-unknown">--</span></div>
<div class="row"><span class="lbl">Confidence</span><span class="val" id="lConf">--</span></div>
<div class="row"><span class="lbl">Coverage</span><span class="val" id="lCov">--</span></div>
<div class="row"><span class="lbl">Glare</span><span class="val" id="lGlare">--</span></div>
<div class="row"><span class="lbl">Uniformity</span><span class="val" id="lUnif">--</span></div>
<h2 style="margin-top:14px">BASELINES</h2>
<div class="row"><span class="lbl">Sodium Baseline</span><span class="val" id="sBase">--</span></div>
<div class="row"><span class="lbl">Sodium Base RGB</span><span class="val" id="sBaseRgb">--</span></div>
<div class="row"><span class="lbl">Lactate Baseline</span><span class="val" id="lBase">--</span></div>
<div class="row"><span class="lbl">Lactate Base RGB</span><span class="val" id="lBaseRgb">--</span></div>
</div>
</div>
<script>
const bcgClass=s=>{s=(s||'').toUpperCase();return s.includes('BLUE-GREEN')?'s-bluegreen':s.includes('BLUE')?'s-blue':s.includes('GREEN')?'s-green':s.includes('YELLOW-GREEN')?'s-yellowgreen':s.includes('YELLOW')?'s-yellow':s.includes('PALE')?'s-pale':'s-unknown';};
async function poll(){
  try{
    const [fr,ld]=await Promise.all([fetch('/api/frame').then(r=>r.json()),fetch('/api/live').then(r=>r.json())]);
    if(fr.image)document.getElementById('camImg').src='data:image/jpeg;base64,'+fr.image;
    document.getElementById('detected').textContent=ld.detected?'YES':'NO';
    document.getElementById('detConf').textContent=ld.detection_confidence?ld.detection_confidence+'%':'--';
    const s=ld.sodium||{};
    document.getElementById('sodiumPct').textContent=s.percentage!=null?s.percentage.toFixed(1)+'%':'--';
    document.getElementById('sRgb').textContent=s.rgb?s.rgb.map(v=>Math.round(v)).join(', '):'--';
    document.getElementById('sHsv').textContent=s.hsv?s.hsv.map(v=>v.toFixed(1)).join(', '):'--';
    document.getElementById('sLab').textContent=s.lab?s.lab.map(v=>v.toFixed(1)).join(', '):'--';
    const sBcg=document.getElementById('sBcg');sBcg.textContent=s.color_state||'--';sBcg.className='state '+bcgClass(s.color_state);
    document.getElementById('sConf').textContent=s.confidence?s.confidence+'%':'--';
    document.getElementById('sCov').textContent=s.coverage!=null?(s.coverage*100).toFixed(1)+'%':'--';
    document.getElementById('sGlare').textContent=s.glare_fraction!=null?(s.glare_fraction*100).toFixed(1)+'%':'--';
    document.getElementById('sUnif').textContent=s.color_uniformity!=null?(s.color_uniformity*100).toFixed(1)+'%':'--';
    const l=ld.lactate||{};
    document.getElementById('lactatePct').textContent=l.percentage!=null?l.percentage.toFixed(1)+'%':'--';
    document.getElementById('lRgb').textContent=l.rgb?l.rgb.map(v=>Math.round(v)).join(', '):'--';
    document.getElementById('lHsv').textContent=l.hsv?l.hsv.map(v=>v.toFixed(1)).join(', '):'--';
    document.getElementById('lLab').textContent=l.lab?l.lab.map(v=>v.toFixed(1)).join(', '):'--';
    const lBcg=document.getElementById('lBcg');lBcg.textContent=l.color_state||'--';lBcg.className='state '+bcgClass(l.color_state);
    document.getElementById('lConf').textContent=l.confidence?l.confidence+'%':'--';
    document.getElementById('lCov').textContent=l.coverage!=null?(l.coverage*100).toFixed(1)+'%':'--';
    document.getElementById('lGlare').textContent=l.glare_fraction!=null?(l.glare_fraction*100).toFixed(1)+'%':'--';
    document.getElementById('lUnif').textContent=l.color_uniformity!=null?(l.color_uniformity*100).toFixed(1)+'%':'--';
    const bl=ld.baselines||{};
    const sb=bl.sodium||{};
    document.getElementById('sBase').textContent=sb.is_set?'SET (v'+sb.calibration_version+')':'NOT SET';
    document.getElementById('sBase').style.color=sb.is_set?'#00ff88':'#ff4444';
    document.getElementById('sBaseRgb').textContent=sb.rgb?sb.rgb.map(v=>Math.round(v)).join(', '):'--';
    const lb=bl.lactate||{};
    document.getElementById('lBase').textContent=lb.is_set?'SET (v'+lb.calibration_version+')':'NOT SET';
    document.getElementById('lBase').style.color=lb.is_set?'#00ff88':'#ff4444';
    document.getElementById('lBaseRgb').textContent=lb.rgb?lb.rgb.map(v=>Math.round(v)).join(', '):'--';
    document.getElementById('status').textContent='Connected — polling';
  }catch(e){document.getElementById('status').textContent='Error: '+e.message;}
}
setInterval(poll,1500);poll();
</script>
</body></html>"""


def main():
    print(f"[debug] Starting debug server on port {PORT}...")
    camera.start()
    server = HTTPServer(("0.0.0.0", PORT), DebugHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        camera.stop()
        server.server_close()
        print("[debug] Server stopped.")


if __name__ == "__main__":
    main()
