/**
 * 在「已经打开的 B 站视频页」的控制台里整段粘贴运行。
 * 任意视频均可：按「热门」和「最新」各取公开评论，匿名后下载 CSV。
 * 请先登录你自己的 B 站账号；未登录时接口往往只返回 3 条。
 *
 * 改下面 CONFIG 可跳过弹窗、调整条数。group 留空时默认用 UP 主名称。
 * 下载的 CSV 里 game 列 = 分组，导入工作台后按此对比，不限定产品。
 */
(async () => {
  const CONFIG = {
    group: "",
    version: "",
    prompt: true,
    maxHot: 40,
    maxNewest: 40,
    delayMs: 1200,
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const bvMatch = location.pathname.match(/BV1[\w]+/);
  if (!bvMatch) {
    alert("请在 B 站视频页（网址含 BV）打开后再运行。");
    return;
  }
  const bvid = bvMatch[0];
  const sourceUrl = `https://www.bilibili.com/video/${bvid}`;

  const view = await fetch(
    `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
    { credentials: "include" }
  ).then((r) => r.json());
  if (view.code !== 0 || !view.data) {
    alert("读不到视频信息：" + (view.message || view.code));
    return;
  }

  const aid = view.data.aid;
  const title = view.data.title || "";
  const owner = (view.data.owner && view.data.owner.name) || "";
  const groupDefault = owner || title.slice(0, 24) || "未分组";

  let group = String(CONFIG.group || "").trim();
  let version = String(CONFIG.version || "").trim();
  if (CONFIG.prompt) {
    const gIn = prompt("分组名称（导入分析时按此对比，例如产品名或 UP 名）", group || groupDefault);
    if (gIn === null) return;
    group = gIn.trim() || groupDefault;
    const vIn = prompt("版本 / 期次（可留空）", version);
    if (vIn === null) return;
    version = vIn.trim();
  } else if (!group) {
    group = groupDefault;
  }

  const maxHot = Math.max(1, Number(CONFIG.maxHot) || 40);
  const maxNewest = Math.max(1, Number(CONFIG.maxNewest) || 40);
  const delayMs = Math.max(400, Number(CONFIG.delayMs) || 1200);

  const go = confirm(
    "即将导出：\n" +
      title +
      "\nUP：" +
      (owner || "未知") +
      "\n分组：" +
      group +
      (version ? "\n版本：" + version : "") +
      "\n热门最多 " +
      maxHot +
      " 条，最新最多 " +
      maxNewest +
      " 条。\n不保存昵称，只保存匿名哈希。"
  );
  if (!go) return;

  async function userHash(uid) {
    const buf = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode("fxzp-bili|" + uid)
    );
    const hex = [...new Uint8Array(buf)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return "u_" + hex.slice(0, 12);
  }

  function csvEscape(s) {
    const t = String(s ?? "").replace(/\r?\n/g, " ").replace(/"/g, '""');
    return `"${t}"`;
  }

  async function fetchPage(mode, next, offset) {
    const params = new URLSearchParams({
      type: "1",
      oid: String(aid),
      mode: String(mode),
      plat: "1",
    });
    if (offset) {
      params.set("pagination_str", JSON.stringify({ offset }));
    } else {
      params.set("next", String(next || 0));
    }
    const res = await fetch(
      "https://api.bilibili.com/x/v2/reply/main?" + params.toString(),
      { credentials: "include" }
    );
    return res.json();
  }

  async function collectMode(mode, stratum, limit) {
    const out = [];
    let next = 0;
    let offset = "";
    let pages = 0;
    const pageCap = Math.max(8, Math.ceil(limit / 5) + 2);
    while (out.length < limit && pages < pageCap) {
      const body = await fetchPage(mode, next, offset);
      if (body.code !== 0) {
        console.warn("评论接口失败", body.code, body.message);
        break;
      }
      const data = body.data || {};
      const replies = data.replies || [];
      if (!replies.length) break;
      for (const item of replies) {
        if (out.length >= limit) break;
        const msg = ((item.content && item.content.message) || "").trim();
        if (!msg) continue;
        const ctime = item.ctime
          ? new Date(item.ctime * 1000).toLocaleDateString("en-CA", {
              timeZone: "Asia/Shanghai",
            })
          : "";
        out.push({
          rpid: item.rpid,
          mid: item.mid,
          like: item.like || 0,
          rcount: item.rcount || 0,
          ctime,
          msg,
          stratum,
        });
      }
      const cur = data.cursor || {};
      if (cur.is_end) break;
      const pr = cur.pagination_reply || {};
      offset = pr.next_offset || pr.offset || "";
      next = cur.next || next + 1;
      pages += 1;
      await sleep(delayMs);
    }
    return out;
  }

  console.log("正在导出：", title, "分组", group);
  const hot = await collectMode(3, "hot", maxHot);
  await sleep(delayMs);
  const neu = await collectMode(2, "newest", maxNewest);

  const seen = new Set();
  const merged = [];
  for (const row of [...hot, ...neu]) {
    if (seen.has(row.rpid)) continue;
    seen.add(row.rpid);
    merged.push(row);
  }

  if (merged.length <= 3) {
    alert(
      "只拿到 " +
        merged.length +
        " 条。请先登录 B 站，刷新本视频页后再运行一次。"
    );
  }

  const header = [
    "comment_id",
    "game",
    "version",
    "platform",
    "source_id",
    "source_url",
    "source_title",
    "comment_date",
    "comment_text",
    "like_count",
    "reply_count",
    "sample_stratum",
    "lang_ok",
    "in_time_window",
    "exclude_reason",
    "collection_wave",
    "user_hash",
  ];
  const lines = [header.join(",")];
  for (const row of merged) {
    const hash = await userHash(row.mid);
    const langOk = /[\u4e00-\u9fff]/.test(row.msg) ? "1" : "0";
    lines.push(
      [
        csvEscape("BL_" + bvid + "_" + row.rpid),
        csvEscape(group),
        csvEscape(version),
        csvEscape("Bilibili"),
        csvEscape(bvid),
        csvEscape(sourceUrl),
        csvEscape(title),
        csvEscape(row.ctime),
        csvEscape(row.msg),
        row.like,
        row.rcount,
        csvEscape(row.stratum),
        langOk,
        "1",
        csvEscape(""),
        csvEscape("wave_bilibili"),
        csvEscape(hash),
      ].join(",")
    );
  }

  const blob = new Blob(["\uFEFF" + lines.join("\n")], {
    type: "text/csv;charset=utf-8",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "bili_" + bvid + ".csv";
  a.click();
  console.log("已下载", merged.length, "条。请把文件放到 FXZP\\bili_exports");
})();
