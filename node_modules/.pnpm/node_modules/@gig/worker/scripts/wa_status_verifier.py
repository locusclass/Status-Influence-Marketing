#!/usr/bin/env python3
"""
wa_status_verifier.py

Single-file WhatsApp Status "Viewed by" verification bot.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np
import pytesseract


def _which(cmd: str) -> Optional[str]:
    return shutil.which(cmd)


def check_environment() -> None:
    missing = []
    for tool in ("ffprobe", "ffmpeg", "tesseract"):
        if _which(tool) is None:
            missing.append(tool)
    if missing:
        print("ERROR: Missing required system tools:", ", ".join(missing), file=sys.stderr)
        sys.exit(2)


def run_cmd(cmd: List[str], timeout: int = 30) -> Tuple[int, str, str]:
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout, p.stderr


def safe_float(x: Any, default: float = 0.0) -> float:
    try:
        return float(x)
    except Exception:
        return default


def clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def json_dumps(obj: Any) -> str:
    return json.dumps(obj, indent=2, ensure_ascii=False)


@dataclass
class VideoMetadata:
    codec: str = ""
    width: int = 0
    height: int = 0
    avg_fps: float = 0.0
    r_fps: float = 0.0
    duration_s: float = 0.0
    bitrate: int = 0
    encoder: str = ""
    format_name: str = ""


def inspect_video_metadata(video_path: str) -> Tuple[VideoMetadata, List[str], float]:
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        video_path,
    ]
    rc, out, _ = run_cmd(cmd, timeout=30)
    if rc != 0 or not out.strip():
        return VideoMetadata(), ["ffprobe_failed"], 0.5
    try:
        data = json.loads(out)
    except Exception:
        return VideoMetadata(), ["ffprobe_json_parse_failed"], 0.5

    md = VideoMetadata()
    streams = data.get("streams", [])
    vstream = None
    for s in streams:
        if s.get("codec_type") == "video":
            vstream = s
            break

    fmt = data.get("format", {}) or {}
    md.format_name = str(fmt.get("format_name") or "")
    md.duration_s = safe_float(fmt.get("duration"), 0.0)
    md.bitrate = int(safe_float(fmt.get("bit_rate"), 0.0))
    tags = fmt.get("tags", {}) or {}
    md.encoder = str(tags.get("encoder") or tags.get("ENCODER") or "")

    if vstream:
        md.codec = str(vstream.get("codec_name") or "")
        md.width = int(safe_float(vstream.get("width"), 0))
        md.height = int(safe_float(vstream.get("height"), 0))

        def parse_ratio(r: str) -> float:
            if not r or "/" not in r:
                return 0.0
            num, den = r.split("/", 1)
            den_f = safe_float(den, 0.0)
            if den_f == 0.0:
                return 0.0
            return safe_float(num, 0.0) / den_f

        md.avg_fps = parse_ratio(str(vstream.get("avg_frame_rate") or "0/1"))
        md.r_fps = parse_ratio(str(vstream.get("r_frame_rate") or "0/1"))

    tamper_signals: List[str] = []
    risk = 0.0
    if md.avg_fps > 0 and md.r_fps > 0:
        diff = abs(md.avg_fps - md.r_fps) / max(md.avg_fps, md.r_fps)
        if diff > 0.15:
            tamper_signals.append("variable_fps_suspected")
            risk += 0.15

    encoder_low = md.encoder.lower()
    suspicious_encoders = [
        "after effects",
        "premiere",
        "capcut",
        "kine",
        "inshot",
        "filmora",
        "vlc",
        "handbrake",
        "ffmpeg",
        "avidemux",
    ]
    if any(x in encoder_low for x in suspicious_encoders):
        tamper_signals.append("encoder_indicates_edit_or_reencode")
        risk += 0.15

    if md.width and md.height and md.duration_s > 0 and md.bitrate > 0:
        megapixels = (md.width * md.height) / 1_000_000.0
        bps_per_mp = md.bitrate / max(megapixels, 0.1)
        if bps_per_mp < 250_000:
            tamper_signals.append("very_low_bitrate_for_resolution")
            risk += 0.10

    if not md.codec or md.duration_s <= 0:
        tamper_signals.append("incomplete_metadata")
        risk += 0.10

    return md, tamper_signals, clamp01(risk)


@dataclass
class SampledFrame:
    t_s: float
    frame_bgr: np.ndarray


def extract_frames(video_path: str, fps: float = 2.0, max_seconds: float = 60.0) -> List[SampledFrame]:
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return []

    native_fps = cap.get(cv2.CAP_PROP_FPS)
    if not native_fps or native_fps <= 0:
        native_fps = 30.0

    duration_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration_s = duration_frames / native_fps if duration_frames > 0 else max_seconds
    analyze_s = min(max_seconds, duration_s if duration_s > 0 else max_seconds)
    step_s = 1.0 / max(fps, 0.1)

    frames: List[SampledFrame] = []
    t = 0.0
    while t <= analyze_s + 1e-6:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000.0)
        ret, frame = cap.read()
        if not ret or frame is None:
            break
        frames.append(SampledFrame(t_s=t, frame_bgr=frame))
        t += step_s

    cap.release()
    return frames


def ocr_text(img_bgr: np.ndarray, psm: int = 6, digits_only: bool = False) -> Tuple[str, float]:
    img = img_bgr
    if len(img.shape) == 3:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    else:
        gray = img.copy()
    gray = cv2.normalize(gray, None, 0, 255, cv2.NORM_MINMAX)
    gray = cv2.resize(gray, None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)
    thr = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 11)

    config = f"--oem 1 --psm {psm}"
    if digits_only:
        config += " -c tessedit_char_whitelist=0123456789"

    data = pytesseract.image_to_data(thr, config=config, output_type=pytesseract.Output.DICT)
    texts = data.get("text", [])
    confs = data.get("conf", [])
    tokens = []
    valid_confs = []
    for tx, cf in zip(texts, confs):
        tx = (tx or "").strip()
        try:
            cfi = float(cf)
        except Exception:
            cfi = -1.0
        if tx:
            tokens.append(tx)
        if cfi >= 0:
            valid_confs.append(cfi)

    text = " ".join(tokens).strip()
    mean_conf = (sum(valid_confs) / (len(valid_confs) * 100.0)) if valid_confs else 0.0
    return text, clamp01(mean_conf)


def extract_int_from_text(text: str) -> Optional[int]:
    nums = re.findall(r"\b\d{1,6}\b", text.replace(",", ""))
    if not nums:
        return None
    vals = []
    for n in nums:
        try:
            vals.append(int(n))
        except Exception:
            pass
    return max(vals) if vals else None


def _roi(img: np.ndarray, x0: float, y0: float, x1: float, y1: float) -> np.ndarray:
    h, w = img.shape[:2]
    xa = int(max(0, min(w - 1, x0 * w)))
    xb = int(max(0, min(w, x1 * w)))
    ya = int(max(0, min(h - 1, y0 * h)))
    yb = int(max(0, min(h, y1 * h)))
    if xb <= xa or yb <= ya:
        return img[0:1, 0:1].copy()
    return img[ya:yb, xa:xb].copy()


def detect_whatsapp_status_viewer_screen(frame_bgr: np.ndarray) -> Tuple[float, Dict[str, Any]]:
    details: Dict[str, Any] = {}
    h, w = frame_bgr.shape[:2]
    if h < 200 or w < 200:
        return 0.0, {"reason": "frame_too_small"}

    header = _roi(frame_bgr, 0.0, 0.0, 1.0, 0.20)
    header_text, header_conf = ocr_text(header, psm=6, digits_only=False)
    header_text_low = header_text.lower()
    keyword_hit = ("viewed" in header_text_low) or ("viewed by" in header_text_low)

    details["header_text"] = header_text
    details["header_ocr_conf"] = header_conf
    details["keyword_hit"] = keyword_hit

    gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 80, 160)
    header_edges = _roi(edges, 0.0, 0.0, 1.0, 0.20)
    list_region = _roi(edges, 0.0, 0.20, 1.0, 1.0)

    header_edge_density = float(np.mean(header_edges > 0))
    list_edge_density = float(np.mean(list_region > 0))
    details["header_edge_density"] = header_edge_density
    details["list_edge_density"] = list_edge_density

    lr = _roi(edges, 0.0, 0.25, 1.0, 1.0)
    proj = lr.mean(axis=1)
    proj_smooth = cv2.GaussianBlur(proj.reshape(-1, 1), (1, 31), 0).flatten()
    if proj_smooth.max() > 0:
        proj_norm = proj_smooth / proj_smooth.max()
    else:
        proj_norm = proj_smooth
    peaks = np.where(
        (proj_norm[1:-1] > proj_norm[:-2])
        & (proj_norm[1:-1] > proj_norm[2:])
        & (proj_norm[1:-1] > 0.35)
    )[0]
    peak_count = int(len(peaks))
    details["row_peak_count"] = peak_count

    score = 0.0
    if keyword_hit:
        score += 0.55 * clamp01(0.5 + header_conf)
    else:
        score += 0.10 * clamp01(header_conf)

    if list_edge_density > header_edge_density:
        score += 0.15 * clamp01((list_edge_density - header_edge_density) * 6.0)
    score += 0.30 * clamp01(peak_count / 18.0)
    return clamp01(score), details


def compute_viewer_count_roi(frame_bgr: np.ndarray) -> np.ndarray:
    return _roi(frame_bgr, 0.10, 0.06, 0.90, 0.25)


def extract_viewer_count(frame_bgr: np.ndarray) -> Tuple[Optional[int], float, str]:
    roi = compute_viewer_count_roi(frame_bgr)
    text, conf = ocr_text(roi, psm=6, digits_only=False)
    n = extract_int_from_text(text)
    if n is None:
        text2, conf2 = ocr_text(roi, psm=7, digits_only=True)
        n2 = extract_int_from_text(text2)
        if n2 is not None:
            return n2, max(conf, conf2), text2
        return None, max(conf, conf2), text
    return n, conf, text


def verify_viewer_count_stability(
    frames: List[SampledFrame], ui_mask: List[bool], burst_len: int = 10
) -> Tuple[Optional[int], float, Dict[str, Any]]:
    details: Dict[str, Any] = {"per_frame": []}
    idxs = [i for i, ok in enumerate(ui_mask) if ok]
    if not idxs:
        return None, 0.0, {"reason": "no_ui_frames"}

    center = idxs[len(idxs) // 2]
    start = max(0, center - burst_len // 2)
    end = min(len(frames), start + burst_len)
    start = max(0, end - burst_len)

    counts: List[Optional[int]] = []
    confs: List[float] = []
    for i in range(start, end):
        n, conf, txt = extract_viewer_count(frames[i].frame_bgr)
        counts.append(n)
        confs.append(conf)
        details["per_frame"].append(
            {"i": i, "t_s": frames[i].t_s, "count": n, "conf": conf, "text": txt[:120]}
        )

    freq: Dict[int, int] = {}
    for n in counts:
        if n is None:
            continue
        freq[n] = freq.get(n, 0) + 1

    if not freq:
        return None, float(np.mean(confs) if confs else 0.0), {"reason": "ocr_no_numbers", **details}

    best_n = max(freq.items(), key=lambda kv: kv[1])[0]
    best_hits = freq[best_n]
    total = len(counts)
    hit_rate = best_hits / max(total, 1)
    mean_conf = float(
        np.mean([c for c, n in zip(confs, counts) if n == best_n]) if best_hits else np.mean(confs)
    )
    final_conf = clamp01(0.65 * hit_rate + 0.35 * mean_conf)
    accepted = hit_rate >= 0.60 and final_conf >= 0.45

    details.update(
        {
            "burst_start": start,
            "burst_end": end,
            "mode_count": best_n,
            "mode_hits": best_hits,
            "hit_rate": hit_rate,
            "mean_conf_mode": mean_conf,
            "accepted": accepted,
        }
    )

    if not accepted:
        return None, final_conf, details
    return best_n, final_conf, details


def detect_scroll(frames: List[SampledFrame], ui_mask: List[bool]) -> Tuple[bool, float, Dict[str, Any]]:
    details: Dict[str, Any] = {"events": []}
    if len(frames) < 3:
        return False, 0.0, {"reason": "too_few_frames"}
    idxs = [i for i, ok in enumerate(ui_mask) if ok]
    if len(idxs) < 3:
        return False, 0.0, {"reason": "insufficient_ui_frames"}

    def header_roi(img):
        return _roi(img, 0.0, 0.0, 1.0, 0.22)

    def list_roi(img):
        return _roi(img, 0.0, 0.22, 1.0, 1.0)

    motion_scores = []
    header_motion_scores = []
    for a, b in zip(idxs[:-1], idxs[1:]):
        fa = frames[a].frame_bgr
        fb = frames[b].frame_bgr
        ha = cv2.cvtColor(header_roi(fa), cv2.COLOR_BGR2GRAY)
        hb = cv2.cvtColor(header_roi(fb), cv2.COLOR_BGR2GRAY)
        la = cv2.cvtColor(list_roi(fa), cv2.COLOR_BGR2GRAY)
        lb = cv2.cvtColor(list_roi(fb), cv2.COLOR_BGR2GRAY)
        hscore = float(cv2.absdiff(ha, hb).mean() / 255.0)
        lscore = float(cv2.absdiff(la, lb).mean() / 255.0)
        header_motion_scores.append(hscore)
        motion_scores.append(lscore)

    events = 0
    for i in range(len(motion_scores)):
        lscore = motion_scores[i]
        hscore = header_motion_scores[i]
        if lscore > 0.035 and hscore < 0.020:
            events += 1
            details["events"].append({"pair_index": i, "list_motion": lscore, "header_motion": hscore})

    event_rate = events / max(len(motion_scores), 1)
    liveness_score = clamp01(event_rate * 2.5)
    passed = events >= 2 and liveness_score >= 0.25
    details["events_count"] = events
    details["event_rate"] = event_rate
    details["liveness_score"] = liveness_score
    return passed, liveness_score, details


def detect_video_tampering(frames: List[SampledFrame]) -> Tuple[List[str], float, Dict[str, Any]]:
    details: Dict[str, Any] = {}
    if len(frames) < 3:
        return [], 0.0, {"reason": "too_few_frames"}

    sims = []
    diffs = []

    def tiny_sig(img_bgr: np.ndarray) -> np.ndarray:
        g = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
        t = cv2.resize(g, (32, 32), interpolation=cv2.INTER_AREA)
        t = cv2.GaussianBlur(t, (3, 3), 0)
        return t.astype(np.float32)

    prev = tiny_sig(frames[0].frame_bgr)
    for i in range(1, len(frames)):
        cur = tiny_sig(frames[i].frame_bgr)
        d = np.mean(np.abs(cur - prev)) / 255.0
        diffs.append(float(d))
        sims.append(float(1.0 - d))
        prev = cur

    dup_pairs = sum(1 for d in diffs if d < 0.0025)
    dup_rate = dup_pairs / max(len(diffs), 1)
    cut_pairs = sum(1 for d in diffs if d > 0.12)
    cut_rate = cut_pairs / max(len(diffs), 1)

    signals: List[str] = []
    risk = 0.0
    if dup_rate > 0.35 and len(diffs) >= 10:
        signals.append("many_near_duplicate_frames")
        risk += 0.15
    if cut_rate > 0.20:
        signals.append("many_abrupt_cuts_or_discontinuities")
        risk += 0.10

    header_diffs = []
    count_diffs = []
    for i in range(1, len(frames)):
        a = frames[i - 1].frame_bgr
        b = frames[i].frame_bgr
        header_a = cv2.cvtColor(_roi(a, 0.0, 0.0, 1.0, 0.22), cv2.COLOR_BGR2GRAY)
        header_b = cv2.cvtColor(_roi(b, 0.0, 0.0, 1.0, 0.22), cv2.COLOR_BGR2GRAY)
        count_a = cv2.cvtColor(compute_viewer_count_roi(a), cv2.COLOR_BGR2GRAY)
        count_b = cv2.cvtColor(compute_viewer_count_roi(b), cv2.COLOR_BGR2GRAY)
        hdiff = float(cv2.absdiff(header_a, header_b).mean() / 255.0)
        cdiff = float(cv2.absdiff(count_a, count_b).mean() / 255.0)
        header_diffs.append(hdiff)
        count_diffs.append(cdiff)

    if header_diffs and count_diffs:
        suspicious = sum(1 for h, c in zip(header_diffs, count_diffs) if h < 0.01 and c > 0.05)
        susp_rate = suspicious / max(len(header_diffs), 1)
        if susp_rate > 0.20:
            signals.append("count_roi_changes_while_header_stable")
            risk += 0.10
        details["overlay_suspicious_rate"] = susp_rate

    details["dup_rate"] = dup_rate
    details["cut_rate"] = cut_rate
    details["mean_diff"] = float(np.mean(diffs) if diffs else 0.0)
    return signals, clamp01(risk), details


def compute_scores(
    ui_auth: float,
    viewer_conf: float,
    liveness_score: float,
    tamper_risk: float,
    ui_detected: bool,
    viewer_count_present: bool,
    scroll_passed: bool,
) -> Tuple[Dict[str, float], str]:
    ui = clamp01(ui_auth)
    vc = clamp01(viewer_conf)
    lv = clamp01(liveness_score)
    tr = clamp01(tamper_risk)
    final = clamp01(0.40 * ui + 0.30 * vc + 0.20 * lv - 0.10 * tr)

    if not ui_detected:
        verdict = "REJECTED"
    elif final >= 0.85 and viewer_count_present and scroll_passed:
        verdict = "VERIFIED"
    elif final >= 0.70:
        verdict = "PROBABLE"
    else:
        verdict = "REJECTED"

    scores = {
        "ui_authenticity": ui,
        "viewer_count": vc,
        "liveness": lv,
        "tamper_risk": tr,
        "final": final,
    }
    return scores, verdict


def verify_video(video_path: str, fps: float = 2.0, max_seconds: float = 60.0) -> Dict[str, Any]:
    t0 = time.time()
    md, md_signals, md_risk = inspect_video_metadata(video_path)
    frames = extract_frames(video_path, fps=fps, max_seconds=max_seconds)
    if not frames:
        return {
            "error": "failed_to_extract_frames",
            "tamper_signals": md_signals + ["no_frames"],
            "scores": {"final": 0.0},
            "verdict": "REJECTED",
        }

    ui_scores: List[float] = []
    ui_mask: List[bool] = []
    for sf in frames:
        s, _ = detect_whatsapp_status_viewer_screen(sf.frame_bgr)
        ui_scores.append(s)
        ui_mask.append(s >= 0.70)

    k = max(3, int(len(ui_scores) * 0.25))
    topk = sorted(ui_scores, reverse=True)[:k]
    ui_auth = float(np.mean(topk)) if topk else float(np.mean(ui_scores))
    ui_detected = sum(ui_mask) >= 3

    viewer_count, viewer_conf, vc_details = verify_viewer_count_stability(frames, ui_mask, burst_len=10)
    scroll_passed, liveness_score, live_details = detect_scroll(frames, ui_mask)
    frame_signals, frame_risk, frame_details = detect_video_tampering(frames)

    tamper_signals: List[str] = []
    tamper_signals.extend(md_signals)
    tamper_signals.extend(frame_signals)
    tamper_risk = clamp01(0.55 * md_risk + 0.45 * frame_risk)

    scores, verdict = compute_scores(
        ui_auth=ui_auth,
        viewer_conf=viewer_conf,
        liveness_score=liveness_score,
        tamper_risk=tamper_risk,
        ui_detected=ui_detected,
        viewer_count_present=(viewer_count is not None),
        scroll_passed=scroll_passed,
    )

    elapsed = time.time() - t0
    report: Dict[str, Any] = {
        "ui_detected": bool(ui_detected),
        "viewer_count": viewer_count,
        "viewer_count_confidence": round(float(viewer_conf), 4),
        "scroll_detected": bool(scroll_passed),
        "tamper_signals": tamper_signals,
        "scores": {k: round(float(v), 4) for k, v in scores.items()},
        "verdict": verdict,
        "metadata": {
            "codec": md.codec,
            "resolution": f"{md.width}x{md.height}",
            "avg_fps": round(md.avg_fps, 3),
            "r_fps": round(md.r_fps, 3),
            "duration_s": round(md.duration_s, 3),
            "bitrate": md.bitrate,
            "encoder": md.encoder,
            "format": md.format_name,
        },
        "debug": {
            "ui_auth_topk_mean": round(ui_auth, 4),
            "ui_frames_detected": int(sum(ui_mask)),
            "frame_count_sampled": len(frames),
            "analysis_seconds": round(elapsed, 3),
            "metadata_risk": round(float(md_risk), 4),
            "frame_risk": round(float(frame_risk), 4),
            "frame_tamper_details": frame_details,
            "viewer_count_details": vc_details,
            "liveness_details": live_details,
        },
    }
    return report


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="WhatsApp Status 'Viewed by' verification bot (single script).")
    p.add_argument("--video", required=True, help="Path to screen recording video (mp4/mov).")
    p.add_argument("--fps", type=float, default=2.0, help="Sampling fps for analysis (default: 2).")
    p.add_argument("--max-seconds", type=float, default=60.0, help="Max seconds of video to analyze (default: 60).")
    p.add_argument("--json-output", default="", help="Optional path to save JSON report.")
    p.add_argument("--quiet", action="store_true", help="Only print JSON (no extra lines).")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    video_path = args.video
    check_environment()
    if not os.path.exists(video_path):
        print(f"ERROR: video not found: {video_path}", file=sys.stderr)
        sys.exit(2)
    report = verify_video(video_path, fps=args.fps, max_seconds=args.max_seconds)
    out = json_dumps(report)
    print(out)
    if args.json_output:
        try:
            with open(args.json_output, "w", encoding="utf-8") as f:
                f.write(out)
        except Exception as e:
            print(f"WARNING: failed to write json output: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
