#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""capture_ui_pages.py — 公网页面的浏览器目视核验（Chrome DevTools 真实操作）。

产出（09_问津智能体/pages_app/运行记录/）：
  01_home.png        首页（1280，含公网演示横幅）
  02_report.png      示例材料真实分析后的报告（含真实联网参考）
  03_narrow390.png   390px 窄屏（Emulation.setDeviceMetricsOverride）
  04_print.pdf       A4 打印稿（Page.printToPDF）
  measure.json       测量结果

用法：python3 capture_ui_pages.py [--port 8081]
前置：本机已起 pages_app 服务（node server.js）。
"""
import argparse
import base64
import json
import pathlib
import subprocess
import time
import urllib.request

import websocket

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
OUT = ROOT / "运行记录"


class CDP:
    def __init__(self, port=9460, profile="/tmp/wenjin-pages-cdp"):
        self.proc = subprocess.Popen(
            [CHROME, "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
             f"--remote-debugging-port={port}", f"--user-data-dir={profile}",
             "--window-size=1280,1600", "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.ws = None
        self._id = 0
        for _ in range(60):
            try:
                tabs = json.loads(urllib.request.urlopen(
                    f"http://127.0.0.1:{port}/json", timeout=1).read())
                page = next(t for t in tabs if t["type"] == "page")
                self.ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=40)
                break
            except Exception:
                time.sleep(0.3)
        if not self.ws:
            raise RuntimeError("无法连接 Chrome DevTools")

    def call(self, method, **params):
        self._id += 1
        self.ws.send(json.dumps({"id": self._id, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self._id:
                if "error" in msg:
                    raise RuntimeError(msg["error"])
                return msg.get("result", {})

    def js(self, expr):
        return self.call("Runtime.evaluate", expression=expr, returnByValue=True
                         ).get("result", {}).get("value")

    def shot(self, path):
        r = self.call("Page.captureScreenshot", format="png")
        path.write_bytes(base64.b64decode(r["data"]))

    def close(self):
        try:
            self.ws.close()
        finally:
            self.proc.terminate()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8081)
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    base = f"http://127.0.0.1:{a.port}/"
    c = CDP()
    m = {}
    try:
        c.call("Page.enable")
        c.call("Page.navigate", url=base + "?auto=sample")
        # ?auto=sample 会跑一次真实分析＋真实联网检索，给足时间
        for _ in range(30):
            time.sleep(1)
            if c.js("document.getElementById('report').classList.contains('on')"):
                time.sleep(3)   # 等参考检索渲染
                break
        m["report_rendered"] = c.js("document.getElementById('report').classList.contains('on')")
        m["stage"] = c.js("document.getElementById('stage-badge').innerText")
        m["claims_rows"] = c.js("document.querySelectorAll('#claims tr').length")
        m["banner_text"] = (c.js("document.getElementById('dep-banner').innerText") or "")[:120]
        m["refs_rendered"] = c.js("document.querySelectorAll('#refs .ref').length")
        m["searchmeta"] = (c.js("document.getElementById('searchmeta').innerText") or "")[:120]
        # 泄漏检查：报告区内不得出现 ** 或裸 None
        m["leak"] = c.js(
            "(function(){var t=document.getElementById('report').innerText;"
            "return {stars: (t.match(/\\*\\*/g)||[]).length, none: (t.match(/None/g)||[]).length};})()")
        # 报告截图
        c.js("window.scrollTo(0, document.getElementById('report').offsetTop - 56); 1")
        time.sleep(0.6)
        c.shot(OUT / "02_report.png")
        # 首页
        c.js("window.scrollTo(0,0); document.getElementById('report').classList.remove('on'); 1")
        time.sleep(0.5)
        m["home_banner"] = bool(c.js("document.getElementById('dep-banner').innerText"))
        c.shot(OUT / "01_home.png")
        # 窄屏 390
        c.call("Emulation.setDeviceMetricsOverride", width=390, height=1500,
               deviceScaleFactor=2, mobile=True)
        c.js("document.getElementById('report').classList.add('on'); 1")
        time.sleep(1.0)
        m["narrow"] = json.loads(c.js(
            "JSON.stringify({sw:document.documentElement.scrollWidth,"
            "cw:document.documentElement.clientWidth})"))
        c.js("window.scrollTo(0, document.getElementById('report').offsetTop - 56); 1")
        time.sleep(0.6)
        c.shot(OUT / "03_narrow390.png")
        c.call("Emulation.clearDeviceMetricsOverride")
        # A4 打印
        pdf = self_pdf(c)
        (OUT / "04_print.pdf").write_bytes(pdf)
        m["print_bytes"] = len(pdf)
    finally:
        c.close()
    (OUT / "measure.json").write_text(json.dumps(m, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(m, ensure_ascii=False, indent=2))
    ok = (m.get("report_rendered") and (m.get("claims_rows") or 0) > 0
          and m.get("narrow", {}).get("sw", 9999) <= m.get("narrow", {}).get("cw", 0) + 1
          and (m.get("leak") or {}).get("stars", 99) == 0
          and (m.get("leak") or {}).get("none", 99) == 0
          and (m.get("print_bytes") or 0) > 100000
          and m.get("home_banner"))
    print("目视核验（公网版）：", "通过" if ok else "未通过")
    return 0 if ok else 1


def self_pdf(c):
    import struct
    r = c.call("Page.printToPDF", paperWidth=8.27, paperHeight=11.69,
               marginTop=0.4, marginBottom=0.4, printBackground=True)
    return base64.b64decode(r["data"])


if __name__ == "__main__":
    raise SystemExit(main())
