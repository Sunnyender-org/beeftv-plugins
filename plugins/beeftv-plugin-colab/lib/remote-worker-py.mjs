// 部署到 Colab 实例 /content/beeftv_colab_worker.py 的后台工作进程。
// 全程仅在云端本机 127.0.0.1:8188 拉起 ComfyUI，不开任何公网端口或穿透隧道；
// 通过 /content/beeftv_worker/ 目录下的 JSON 与文件同本机 BeefTV 插件通信。

import { COMFYUI_COMMIT, COMFYUI_REPO_URL } from "./constants.mjs";

export const REMOTE_WORKER_ROOT = "/content/beeftv_worker";
export const REMOTE_WORKER_SCRIPT = "/content/beeftv_colab_worker.py";

export function buildKernelLauncherCode() {
  return `
import json, os, subprocess, sys
from pathlib import Path

root = Path(${JSON.stringify(REMOTE_WORKER_ROOT)})
for sub in ("inputs", "jobs", "outputs", "downloads"):
    (root / sub).mkdir(parents=True, exist_ok=True)

pid_file = root / "worker.pid"
alive_pid = None
if pid_file.exists():
    try:
        candidate = int(pid_file.read_text().strip())
        os.kill(candidate, 0)
        alive_pid = candidate
    except Exception:
        alive_pid = None

if alive_pid is None:
    log_fp = open(root / "worker.log", "a", buffering=1)
    proc = subprocess.Popen(
        [sys.executable, ${JSON.stringify(REMOTE_WORKER_SCRIPT)}],
        cwd=str(root),
        stdout=log_fp,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    pid_file.write_text(str(proc.pid))
    print(json.dumps({"ok": True, "pid": proc.pid, "reused": False}), flush=True)
else:
    print(json.dumps({"ok": True, "pid": alive_pid, "reused": True}), flush=True)
`.trim();
}

export function buildRemoteWorkerPythonSource() {
  return `#!/usr/bin/env python3
"""BeefTV Colab private loopback worker (127.0.0.1:8188 only, no external tunnels)."""

from pathlib import Path
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

ROOT = Path(${JSON.stringify(REMOTE_WORKER_ROOT)})
COMFY_DIR = ROOT / "ComfyUI"
INPUTS_DIR = ROOT / "inputs"
JOBS_DIR = ROOT / "jobs"
OUTPUTS_DIR = ROOT / "outputs"
DOWNLOADS_DIR = ROOT / "downloads"
STATE_FILE = ROOT / "state.json"
COMFY_LOG = ROOT / "comfy.log"
COMFY_URL = "http://127.0.0.1:8188"
COMFY_REPO = ${JSON.stringify(COMFYUI_REPO_URL)}
COMFY_COMMIT = ${JSON.stringify(COMFYUI_COMMIT)}

for _sub in (INPUTS_DIR, JOBS_DIR, OUTPUTS_DIR, DOWNLOADS_DIR):
    _sub.mkdir(parents=True, exist_ok=True)

_state_lock = threading.Lock()
_state = {
    "pid": os.getpid(),
    "heartbeat_unix": time.time(),
    "gpu_name": "",
    "vram_total_mib": 0,
    "vram_used_mib": 0,
    "disk_free_gb": 0.0,
    "stage": "idle",
    "stage_detail": "云端显卡已就绪，等待生成指令",
    "active_family": "",
    "active_job_id": "",
    "download_progress": None,
}


def probe_hardware():
    gpu_name = ""
    used_mib = 0
    total_mib = 0
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=name,memory.used,memory.total", "--format=csv,noheader,nounits"],
            text=True,
            timeout=5,
        ).strip().splitlines()[0]
        parts = [p.strip() for p in out.split(",")]
        gpu_name = parts[0]
        used_mib = int(parts[1])
        total_mib = int(parts[2])
    except Exception:
        pass
    try:
        _total, _used, free = shutil.disk_usage("/content")
        disk_free_gb = round(free / (1024 ** 3), 2)
    except Exception:
        disk_free_gb = 0.0
    return gpu_name, used_mib, total_mib, disk_free_gb


def flush_state(**updates):
    with _state_lock:
        _state.update(updates)
        _state["heartbeat_unix"] = time.time()
        payload = dict(_state)
        tmp = STATE_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
        os.replace(tmp, STATE_FILE)


def write_job_result(job_id: str, payload: dict):
    target = JOBS_DIR / f"{job_id}.res.json"
    tmp = JOBS_DIR / f"{job_id}.res.json.tmp"
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    os.replace(tmp, target)


def heartbeat_loop():
    while True:
        gpu_name, used_mib, total_mib, disk_free_gb = probe_hardware()
        flush_state(
            gpu_name=gpu_name,
            vram_used_mib=used_mib,
            vram_total_mib=total_mib,
            disk_free_gb=disk_free_gb,
        )
        time.sleep(2.5)


def comfy_request(route: str, body=None, timeout: int = 30):
    req = urllib.request.Request(
        COMFY_URL + route,
        data=None if body is None else json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else None


def is_comfy_ready() -> bool:
    try:
        comfy_request("/system_stats", timeout=3)
        return True
    except Exception:
        return False


def ensure_comfy_installed():
    marker = ROOT / f".comfy_ready_{COMFY_COMMIT[:10]}"
    if marker.exists() and (COMFY_DIR / "main.py").exists():
        return
    flush_state(stage="installing_comfyui", stage_detail="正在云端实例安装 ComfyUI 生成引擎（首次约需 45 秒）")
    if not COMFY_DIR.exists():
        subprocess.run(["git", "clone", "--depth", "1", COMFY_REPO, str(COMFY_DIR)], check=True)
    head = subprocess.check_output(["git", "-C", str(COMFY_DIR), "rev-parse", "HEAD"], text=True).strip()
    if head != COMFY_COMMIT:
        subprocess.run(["git", "-C", str(COMFY_DIR), "fetch", "--depth", "1", "origin", COMFY_COMMIT], check=True)
        subprocess.run(["git", "-C", str(COMFY_DIR), "checkout", "--detach", COMFY_COMMIT], check=True)
    subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "-q",
            "-r",
            str(COMFY_DIR / "requirements.txt"),
            "huggingface_hub[hf_transfer]",
            "websocket-client",
            "ftfy",
            "pillow",
        ],
        check=True,
    )
    marker.write_text(COMFY_COMMIT)


def current_partial_bytes(repo_dir: Path, rel_path: str) -> int:
    direct = repo_dir / rel_path
    if direct.exists():
        try:
            return direct.stat().st_size
        except Exception:
            pass
    best = 0
    for item in repo_dir.rglob("*"):
        if item.is_file() and (item.name.endswith(".incomplete") or item.name == Path(rel_path).name):
            try:
                best = max(best, item.stat().st_size)
            except Exception:
                pass
    return best


def evict_other_weights_if_tight(needed_bytes: int, keep_basenames: set):
    _total, _used, free = shutil.disk_usage("/content")
    if free >= needed_bytes + 4 * (1024 ** 3):
        return
    for item in DOWNLOADS_DIR.rglob("*"):
        if item.is_file() and item.name not in keep_basenames:
            if item.suffix in (".safetensors", ".incomplete", ".lock") or ".cache" in item.parts:
                try:
                    item.unlink()
                except Exception:
                    pass


def ensure_weights(weight_spec: dict):
    os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
    os.environ["HF_XET_HIGH_PERFORMANCE"] = "1"
    from huggingface_hub import hf_hub_download

    repo = weight_spec["repo"]
    revision = weight_spec["revision"]
    files = weight_spec.get("files", [])
    keep_names = {Path(f["path"]).name for f in files}

    missing = []
    for entry in files:
        basename = Path(entry["path"]).name
        dest = COMFY_DIR / "models" / entry["subdir"] / basename
        expected = int(entry.get("bytes") or 0)
        if dest.exists() and (expected <= 0 or dest.stat().st_size == expected):
            continue
        missing.append(entry)

    if not missing:
        return

    needed_total = sum(int(e.get("bytes") or 0) for e in missing)
    evict_other_weights_if_tight(needed_total, keep_names)

    repo_dir = DOWNLOADS_DIR / repo.replace("/", "--")
    repo_dir.mkdir(parents=True, exist_ok=True)
    completed_bytes = 0

    for index, entry in enumerate(missing):
        rel_path = entry["path"]
        basename = Path(rel_path).name
        expected = int(entry.get("bytes") or 0)
        t0 = time.monotonic()
        done_event = threading.Event()
        holder = {"path": None, "err": None}

        def _worker():
            os.environ["HF_HUB_ENABLE_HF_TRANSFER"] = "1"
            try:
                holder["path"] = hf_hub_download(repo, rel_path, revision=revision, local_dir=str(repo_dir))
            except Exception:
                os.environ["HF_HUB_ENABLE_HF_TRANSFER"] = "0"
                try:
                    holder["path"] = hf_hub_download(repo, rel_path, revision=revision, local_dir=str(repo_dir))
                except Exception as exc2:
                    holder["err"] = exc2
            finally:
                done_event.set()

        th = threading.Thread(target=_worker, daemon=True)
        th.start()

        while not done_event.wait(timeout=1.5):
            cur = min(expected, current_partial_bytes(repo_dir, rel_path)) if expected > 0 else 0
            overall_cur = completed_bytes + cur
            elapsed = max(0.2, time.monotonic() - t0)
            speed_mbps = round((cur / (1024 ** 2)) / elapsed, 1)
            gb_cur = round(overall_cur / (1024 ** 3), 1)
            gb_tot = round(needed_total / (1024 ** 3), 1)
            flush_state(
                stage="downloading_weights",
                stage_detail=f"正在下载模型权重（{index + 1}/{len(missing)}）：{gb_cur} / {gb_tot} GB（{speed_mbps} MB/s）",
                download_progress={
                    "file": basename,
                    "file_index": index + 1,
                    "file_count": len(missing),
                    "current_bytes": overall_cur,
                    "total_bytes": needed_total,
                    "speed_mbps": speed_mbps,
                },
            )

        if holder["err"] is not None:
            raise RuntimeError(f"下载模型文件 {basename} 失败：{holder['err']}")

        local_file = Path(holder["path"])
        if expected > 0 and local_file.stat().st_size != expected:
            raise RuntimeError(f"模型文件 {basename} 大小校验未通过")

        dest = COMFY_DIR / "models" / entry["subdir"] / basename
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists() or dest.is_symlink():
            dest.unlink()
        dest.symlink_to(local_file)
        completed_bytes += local_file.stat().st_size

    flush_state(download_progress=None)


_comfy_proc = None


def ensure_comfy_running():
    global _comfy_proc
    if is_comfy_ready():
        return
    flush_state(stage="starting_comfyui", stage_detail="正在启动云端本地生图服务")
    log_fp = open(COMFY_LOG, "a", buffering=1)
    _comfy_proc = subprocess.Popen(
        [
            sys.executable,
            str(COMFY_DIR / "main.py"),
            "--listen",
            "127.0.0.1",
            "--port",
            "8188",
            "--disable-auto-launch",
            "--disable-api-nodes",
        ],
        cwd=str(COMFY_DIR),
        stdout=log_fp,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    for _ in range(120):
        if is_comfy_ready():
            return
        if _comfy_proc.poll() is not None:
            tail = COMFY_LOG.read_text(errors="replace")[-2000:] if COMFY_LOG.exists() else ""
            raise RuntimeError(f"生图引擎启动异常退出：{tail}")
        time.sleep(1.5)
    raise TimeoutError("生图引擎启动超时")


def extract_error_message(status_obj: dict) -> str:
    for item in status_obj.get("messages", []) or []:
        if isinstance(item, list) and len(item) >= 2 and item[0] == "execution_error":
            detail = item[1] or {}
            node_type = detail.get("node_type", "")
            msg = detail.get("exception_message") or "节点执行失败"
            return f"节点 {node_type} 出错：{msg}".strip()
    return "云端模型推理失败"


def process_job(req_path: Path):
    job = json.loads(req_path.read_text())
    job_id = str(job["job_id"])
    family = str(job["family"])
    weight_spec = job["weight_spec"]
    workflow = job["workflow"]
    output_node_id = str(job.get("output_node_id") or "")
    ref_files = job.get("ref_files") or []

    flush_state(active_job_id=job_id, stage="preparing", stage_detail="正在检查云端运行环境")
    ensure_comfy_installed()
    ensure_weights(weight_spec)
    ensure_comfy_running()

    with _state_lock:
        prev_family = _state.get("active_family") or ""

    if prev_family and prev_family != family:
        flush_state(stage="switching_model", stage_detail="正在切换模型并释放上一套权重显存")
        try:
            comfy_request("/free", {"unload_models": True, "free_memory": True}, timeout=20)
            time.sleep(1.0)
        except Exception:
            pass

    comfy_input_dir = COMFY_DIR / "input"
    comfy_input_dir.mkdir(parents=True, exist_ok=True)

    try:
        for fname in ref_files:
            src = INPUTS_DIR / fname
            if not src.exists():
                raise RuntimeError(f"缺少参考图文件 {fname}")
            shutil.copyfile(src, comfy_input_dir / fname)

        flush_state(stage="generating", stage_detail="正在云端显卡上生成画面", active_family=family)
        write_job_result(job_id, {"job_id": job_id, "status": "processing", "stage": "generating"})
        try:
            queued = comfy_request("/prompt", {"prompt": workflow, "client_id": "beeftv-colab"}, timeout=30)
        except urllib.error.HTTPError as exc:
            body_raw = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"工作流校验未通过：{body_raw[:300]}")

        prompt_id = queued.get("prompt_id")
        if not prompt_id:
            raise RuntimeError("生图引擎未返回任务编号")

        t0 = time.monotonic()
        while time.monotonic() - t0 < 900:
            history = comfy_request(f"/history/{prompt_id}", timeout=20) or {}
            if prompt_id in history:
                entry = history[prompt_id]
                status_obj = entry.get("status") or {}
                status_str = status_obj.get("status_str")
                if status_str == "error":
                    raise RuntimeError(extract_error_message(status_obj))
                if status_obj.get("completed") is False:
                    time.sleep(1.5)
                    continue

                outputs = entry.get("outputs") or {}
                chosen_nodes = [outputs[output_node_id]] if output_node_id in outputs else list(outputs.values())
                saved_files = []
                for node_out in chosen_nodes:
                    for img in (node_out or {}).get("images") or []:
                        if img.get("type") == "output" and img.get("filename"):
                            src_img = COMFY_DIR / "output" / img.get("subfolder", "") / img["filename"]
                            if src_img.exists():
                                out_name = f"{job_id}_{len(saved_files) + 1}.png"
                                dst_img = OUTPUTS_DIR / out_name
                                shutil.copyfile(src_img, dst_img)
                                src_img.unlink(missing_ok=True)
                                width, height = 0, 0
                                try:
                                    from PIL import Image
                                    with Image.open(dst_img) as im:
                                        width, height = im.size
                                except Exception:
                                    pass
                                saved_files.append({
                                    "filename": out_name,
                                    "width": width,
                                    "height": height,
                                    "bytes": dst_img.stat().st_size,
                                })
                if not saved_files:
                    raise RuntimeError("云端任务已完成，但没有找到输出图片")

                write_job_result(
                    job_id,
                    {
                        "job_id": job_id,
                        "status": "succeeded",
                        "elapsed_seconds": round(time.monotonic() - t0, 2),
                        "outputs": saved_files,
                    },
                )
                return
            time.sleep(1.8)

        raise TimeoutError("云端生图超过 15 分钟仍未完成，已中止等待")
    finally:
        for fname in ref_files:
            (comfy_input_dir / fname).unlink(missing_ok=True)


def main():
    hb = threading.Thread(target=heartbeat_loop, daemon=True)
    hb.start()
    flush_state(stage="idle", stage_detail="云端显卡已就绪，等待生成指令")

    while True:
        req_files = sorted(JOBS_DIR.glob("*.req.json"), key=lambda p: p.stat().st_mtime)
        if not req_files:
            time.sleep(1.0)
            continue

        for req_path in req_files:
            job_id = req_path.name[:-len(".req.json")]
            res_path = JOBS_DIR / f"{job_id}.res.json"
            if res_path.exists():
                try:
                    existing = json.loads(res_path.read_text())
                    if existing.get("status") in ("succeeded", "failed"):
                        req_path.unlink(missing_ok=True)
                        continue
                except Exception:
                    pass
            try:
                process_job(req_path)
            except Exception as exc:
                write_job_result(
                    job_id,
                    {
                        "job_id": job_id,
                        "status": "failed",
                        "message": str(exc)[:400],
                    },
                )
            finally:
                req_path.unlink(missing_ok=True)
                flush_state(
                    active_job_id="",
                    stage="idle",
                    stage_detail="云端显卡待命中，可继续快速出图",
                    download_progress=None,
                )


if __name__ == "__main__":
    main()
`;
}
