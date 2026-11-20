// Full-screen viewer for case documents (PDF via pdf.js, images, video, text).
import { $, esc, docExt } from "./util.js";

var viewTok = 0;
export function downloadDoc(d) {
  var a = document.createElement("a"); a.href = "/api/files/" + d.id + "?download=1"; document.body.appendChild(a); a.click(); a.remove();
}
export function closeViewer() {
  viewTok++;
  var v = $("docViewer"); if (v) v.remove();
  document.removeEventListener("keydown", viewerKey);
}
function viewerKey(e) { if (e.key === "Escape") closeViewer(); }
export function openViewer(d) {
  closeViewer();
  var tok = ++viewTok, ext = docExt(d.name), url = "/api/files/" + d.id;
  var v = document.createElement("div");
  v.id = "docViewer"; v.className = "viewer"; v.setAttribute("role", "dialog"); v.setAttribute("aria-label", d.name);
  v.innerHTML = '<div class="vbar"><strong class="vname"></strong><span class="spacer"></span>' +
    '<button class="btn" type="button" id="vDl">Download</button><button class="btn primary" type="button" id="vClose">Close</button></div><div class="vbody" id="vBody"><p class="muted">Loading\u2026</p></div>';
  v.querySelector(".vname").textContent = d.name;
  document.body.appendChild(v);
  document.addEventListener("keydown", viewerKey);
  $("vClose").onclick = closeViewer;
  $("vDl").onclick = function () { downloadDoc(d); };
  $("vClose").focus();
  var body = $("vBody");
  function fail() { if (tok === viewTok) body.innerHTML = '<p class="muted">This file could not be displayed. Use Download instead.</p>'; }
  if (ext === "pdf") {
    if (!window.pdfjsLib) return fail();
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    fetch(url).then(function (r) { if (!r.ok) throw 0; return r.arrayBuffer(); }).then(function (buf) {
      return window.pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    }).then(function (pdf) {
      if (tok !== viewTok) return;
      body.innerHTML = "";
      var width = Math.min(body.clientWidth - 24, 1000), dpr = window.devicePixelRatio || 1;
      var chain = Promise.resolve();
      for (var n = 1; n <= pdf.numPages; n++) (function (n) {
        chain = chain.then(function () {
          if (tok !== viewTok) return;
          return pdf.getPage(n).then(function (page) {
            var base = page.getViewport({ scale: 1 }), scale = width / base.width;
            var vp = page.getViewport({ scale: scale * dpr });
            var cv = document.createElement("canvas");
            cv.width = vp.width; cv.height = vp.height;
            cv.style.width = (vp.width / dpr) + "px"; cv.style.height = (vp.height / dpr) + "px";
            cv.className = "vpage"; body.appendChild(cv);
            return page.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise;
          });
        });
      })(n);
      return chain;
    }).catch(fail);
  } else if (/^(png|jpe?g|gif|webp|svg)$/.test(ext)) {
    var im = new Image(); im.alt = d.name; im.className = "vimg";
    im.onload = function () { if (tok === viewTok) { body.innerHTML = ""; body.appendChild(im); } };
    im.onerror = fail; im.src = url;
  } else if (/^(mp4|webm)$/.test(ext)) {
    body.innerHTML = '<video class="vimg" controls src="' + esc(url) + '"></video>';
  } else if (!/^(txt|md|csv|json)$/.test(ext)) {
    body.innerHTML = '<p class="muted">No preview for this file type. Use Download.</p>';
  } else {
    fetch(url).then(function (r) { if (!r.ok) throw 0; return r.text(); }).then(function (t) {
      if (tok !== viewTok) return;
      var pre = document.createElement("pre"); pre.className = "vtext"; pre.textContent = t;
      body.innerHTML = ""; body.appendChild(pre);
    }).catch(fail);
  }
}
