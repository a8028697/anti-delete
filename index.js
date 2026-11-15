(function () {
  "use strict";

  const DEFAULT_MARKER = "# 🗑️ 已被删除";
  const MAX_SAVED = 1000; // 本机最多保存多少条

  const { before, instead } = vendetta.patcher;
  const { findByProps, findByStoreName } = vendetta.metro;

  const unpatches = [];
  const stats = { kept: 0, passed: 0, restored: 0, hooked: false };
  const userDeleting = new Set(); // 你自己点“删除”的消息，照常删除

  let MessageStore = null;
  let UserStore = null;

  // ---------- 设置读写 ----------

  // 被删除时加在消息后面的提示；留空表示不加提示
  function readMarker() {
    try {
      const s = vendetta.plugin.storage.marker;
      if (typeof s === "string") return s;
    } catch (e) {}
    return DEFAULT_MARKER;
  }

  function readRestore() {
    try {
      return vendetta.plugin.storage.restore !== false;
    } catch (e) {
      return true;
    }
  }

  function getSaved() {
    try {
      const s = vendetta.plugin.storage.saved;
      return Array.isArray(s) ? s : [];
    } catch (e) {
      return [];
    }
  }

  // ---------- 保存被删除的消息（存在本机，重启也在） ----------

  // 消息 ID 是很长的数字，按长度再按字典序比较大小
  function cmpId(a, b) {
    a = String(a);
    b = String(b);
    if (a.length !== b.length) return a.length - b.length;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function iso(ts) {
    try {
      if (ts && typeof ts.toISOString === "function") return ts.toISOString();
      if (typeof ts === "string") return ts;
      if (typeof ts === "number") return new Date(ts).toISOString();
    } catch (e) {}
    return new Date().toISOString();
  }

  // 把消息整理成 Discord 服务器返回的格式，之后可以原样放回聊天
  function buildRecord(msg, channelId, guildId) {
    const a = msg.author || {};
    let attachments = [];
    try {
      attachments = Array.from(msg.attachments || []).map((x) => ({
        id: x.id,
        filename: x.filename,
        size: x.size,
        url: x.url,
        proxy_url: x.proxy_url || x.proxyURL || x.url,
        width: x.width,
        height: x.height,
        content_type: x.content_type || x.contentType,
      }));
    } catch (e) {}

    let content = typeof msg.content === "string" ? msg.content : "";
    const marker = readMarker();
    if (marker) {
      if (content === marker) content = "";
      else if (content.endsWith("\n" + marker)) content = content.slice(0, -(marker.length + 1));
    }

    return {
      id: String(msg.id),
      channel_id: String(channelId),
      guild_id: guildId ? String(guildId) : undefined,
      type: 0,
      content: content,
      timestamp: iso(msg.timestamp),
      edited_timestamp: null,
      tts: false,
      mention_everyone: false,
      mentions: [],
      mention_roles: [],
      attachments: attachments,
      embeds: [],
      pinned: false,
      flags: 0,
      author: {
        id: a.id,
        username: a.username,
        discriminator: a.discriminator || "0",
        avatar: a.avatar || null,
        global_name: a.globalName || a.global_name || null,
        bot: !!a.bot,
      },
      deleted_at: Date.now(),
    };
  }

  function saveDeleted(msg, channelId, guildId) {
    try {
      const id = String(msg.id);
      const list = getSaved();
      if (list.some((r) => r.id === id)) return;
      const next = JSON.parse(JSON.stringify(list));
      next.push(JSON.parse(JSON.stringify(buildRecord(msg, channelId, guildId))));
      if (next.length > MAX_SAVED) next.splice(0, next.length - MAX_SAVED);
      vendetta.plugin.storage.saved = next;
    } catch (e) {}
  }

  // ---------- 重新进入聊天时，把已删除的消息放回去 ----------

  // 在 Discord 刚从服务器拉到的消息里，插入落在这一段范围内的已保存消息
  function restoreInto(event) {
    const msgs = event.messages;
    if (!Array.isArray(msgs) || !msgs.length) return null;
    const saved = getSaved().filter((r) => r.channel_id === String(event.channelId));
    if (!saved.length) return null;

    const have = new Set(msgs.map((m) => m.id));
    let min = msgs[0].id;
    let max = msgs[0].id;
    for (const m of msgs) {
      if (cmpId(m.id, min) < 0) min = m.id;
      if (cmpId(m.id, max) > 0) max = m.id;
    }

    const marker = readMarker();
    const extra = [];
    for (const rec of saved) {
      if (have.has(rec.id)) continue;
      const lo = cmpId(rec.id, min);
      const hi = cmpId(rec.id, max);
      const inside = lo >= 0 && hi <= 0;
      const newer = hi > 0 && event.hasMoreAfter === false; // 比最新一条还新（已经是最底部）
      const older = lo < 0 && event.hasMoreBefore === false; // 比最旧一条还旧（已经是最顶部）
      if (!(inside || newer || older)) continue;
      const raw = JSON.parse(JSON.stringify(rec));
      delete raw.deleted_at;
      if (marker) raw.content = raw.content ? raw.content + "\n" + marker : marker;
      extra.push(raw);
    }
    if (!extra.length) return null;

    // 保持和原来一样的排列方向（新的在前，或旧的在前）
    const ascending = msgs.length > 1 && cmpId(msgs[0].id, msgs[msgs.length - 1].id) < 0;
    stats.restored += extra.length;
    return msgs.concat(extra).sort((x, y) => (ascending ? cmpId(x.id, y.id) : cmpId(y.id, x.id)));
  }

  // ---------- 拦截删除 ----------

  function haveStores() {
    if (!MessageStore) MessageStore = findByStoreName("MessageStore");
    if (!UserStore) UserStore = findByStoreName("UserStore");
    return !!(MessageStore && UserStore);
  }

  // 这条被删的消息要不要保留？返回消息表示保留，返回 null 表示放行（照常删除）
  function messageToKeep(channelId, id) {
    if (userDeleting.has(id)) {
      userDeleting.delete(id);
      return null; // 是你自己点的删除
    }
    if (!haveStores()) return null;
    const msg = MessageStore.getMessage(channelId, id);
    if (!msg) return null; // 没加载过，没有内容可留
    const me = UserStore.getCurrentUser();
    if (msg.author && me && msg.author.id === me.id) return null; // 自己发的，照常删
    if ((msg.flags & 64) === 64) return null; // 仅自己可见的临时消息（点“忽略”会走这里）
    return msg;
  }

  // 在被删除的消息后面加提示（用一次“消息编辑”事件，只改本地显示）
  function markDeleted(orig, msg, channelId, guildId) {
    const marker = readMarker();
    if (!marker) return;
    const content = typeof msg.content === "string" ? msg.content : "";
    if (content.indexOf(marker) !== -1) return; // 已经标过了
    orig({
      type: "MESSAGE_UPDATE",
      guildId: guildId,
      message: {
        id: msg.id,
        channel_id: channelId,
        guild_id: guildId,
        content: content ? content + "\n" + marker : marker,
      },
    });
  }

  function keep(orig, msg, channelId, guildId) {
    stats.kept++;
    saveDeleted(msg, channelId, guildId);
    markDeleted(orig, msg, channelId, guildId);
  }

  function onDispatch(args, orig) {
    try {
      const event = args[0];
      const type = event && event.type;

      if (type === "MESSAGE_DELETE") {
        const msg = messageToKeep(event.channelId, event.id);
        if (!msg) {
          stats.passed++;
          return orig(...args);
        }
        keep(orig, msg, event.channelId, event.guildId);
        return; // 拦下删除事件，消息就留在屏幕上
      }

      if (type === "MESSAGE_DELETE_BULK") {
        const pass = [];
        for (const id of event.ids || []) {
          const msg = messageToKeep(event.channelId, id);
          if (msg) {
            keep(orig, msg, event.channelId, event.guildId);
          } else {
            stats.passed++;
            pass.push(id);
          }
        }
        if (!pass.length) return;
        return orig({ ...event, ids: pass });
      }

      if (type === "LOAD_MESSAGES_SUCCESS" && readRestore()) {
        const merged = restoreInto(event);
        if (merged) return orig({ ...event, messages: merged });
      }
    } catch (e) {
      console.error("[防撤回] 出错，按原样处理：", e);
    }
    return orig(...args);
  }

  // ---------- 设置页 ----------

  function Settings() {
    const { React, ReactNative: RN } = vendetta.metro.common;
    const Forms = (vendetta.ui && vendetta.ui.components && vendetta.ui.components.Forms) || {};
    const h = React.createElement;
    const [marker, setMarker] = React.useState(() => readMarker());
    const [restore, setRestore] = React.useState(() => readRestore());
    const [, setTick] = React.useState(0);

    const onMarker = (v) => {
      const text = typeof v === "string" ? v : (v && v.nativeEvent && v.nativeEvent.text) || "";
      setMarker(text);
      try {
        vendetta.plugin.storage.marker = text;
      } catch (e) {}
    };

    const onRestore = (v) => {
      setRestore(v);
      try {
        vendetta.plugin.storage.restore = v;
      } catch (e) {}
    };

    const clear = () => {
      const doClear = () => {
        try {
          vendetta.plugin.storage.saved = [];
        } catch (e) {}
        setTick((n) => n + 1);
      };
      const alerts = vendetta.ui && vendetta.ui.alerts;
      if (alerts && typeof alerts.showConfirmationAlert === "function") {
        alerts.showConfirmationAlert({
          title: "清空记录",
          content: "确定删除本机保存的所有被删除消息吗？",
          confirmText: "清空",
          cancelText: "取消",
          confirmColor: "red",
          onConfirm: doClear,
        });
      } else {
        doClear();
      }
    };

    const note = (str, style) =>
      Forms.FormText
        ? h(Forms.FormText, { style: Object.assign({ marginHorizontal: 16, marginTop: 8 }, style) }, str)
        : h(RN.Text, { style: Object.assign({ margin: 16, color: "#b5bac1" }, style) }, str);

    const pad = (n) => (n < 10 ? "0" + n : "" + n);
    const when = (ts) => {
      const d = new Date(ts || Date.now());
      return pad(d.getMonth() + 1) + "/" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
    };
    const who = (r) => (r.author && (r.author.global_name || r.author.username)) || "未知用户";
    const preview = (r) => {
      const c = (r.content || "").replace(/\s+/g, " ").trim();
      const att = r.attachments && r.attachments.length ? " [附件 " + r.attachments.length + "]" : "";
      return (c.length > 120 ? c.slice(0, 120) + "…" : c) + att;
    };

    const all = getSaved();
    const recent = all.slice().reverse().slice(0, 15);

    const children = [
      Forms.FormInput
        ? h(Forms.FormInput, { title: "被删除时的提示文字", placeholder: DEFAULT_MARKER, value: marker, onChange: onMarker })
        : h(RN.TextInput, {
            value: marker,
            placeholder: DEFAULT_MARKER,
            placeholderTextColor: "#80848e",
            onChangeText: onMarker,
            style: { margin: 16, padding: 12, borderRadius: 8, color: "#fff", backgroundColor: "#2b2d31" },
          }),
      note("提示会加在被删除的消息下面。留空则不加提示，只保留消息。"),
      h(
        RN.View,
        { style: { flexDirection: "row", alignItems: "center", marginHorizontal: 16, marginTop: 16 } },
        note("重新进入聊天时，把已删除的消息放回去", { flex: 1, marginHorizontal: 0, marginTop: 0, margin: 0 }),
        h(RN.Switch, { value: restore, onValueChange: onRestore })
      ),
      note(
        "状态：" +
          (stats.hooked ? "已接管消息删除事件" : "没接上") +
          "\n本机已保存 " +
          all.length +
          " 条被删除的消息。这次已保留 " +
          stats.kept +
          " 条，放回聊天 " +
          stats.restored +
          " 条，放行 " +
          stats.passed +
          " 条（你自己删的、临时消息等）。"
      ),
      h(
        RN.View,
        { style: { alignItems: "center", margin: 16 } },
        h(
          RN.Pressable,
          {
            onPress: clear,
            style: { paddingVertical: 10, paddingHorizontal: 20, borderRadius: 12, backgroundColor: "#da373c" },
          },
          h(RN.Text, { style: { color: "#fff", fontWeight: "600" } }, "清空记录")
        )
      ),
      note("最近被删除的消息（新的在上面）：", { fontWeight: "600" }),
    ];
    if (!recent.length) children.push(note("还没有记录。"));
    for (const r of recent) children.push(note(who(r) + " · " + when(r.deleted_at) + "\n" + preview(r), { marginTop: 10 }));
    children.push(note("被删消息里的图片和文件很快会打不开，文字内容可以长期保留。", { marginBottom: 24 }));

    return h(RN.ScrollView, { keyboardShouldPersistTaps: "handled" }, ...children);
  }

  return {
    onLoad() {
      // 记下你自己点的删除，这些要照常删掉
      try {
        const actions = findByProps("sendMessage", "deleteMessage") || findByProps("deleteMessage");
        if (actions && typeof actions.deleteMessage === "function") {
          unpatches.push(
            before("deleteMessage", actions, (args) => {
              if (args && args[1]) userDeleting.add(String(args[1]));
            })
          );
        }
      } catch (e) {}

      try {
        const Flux = vendetta.metro.common.FluxDispatcher || findByProps("subscribe", "dispatch");
        if (!Flux) throw new Error("找不到 FluxDispatcher");
        unpatches.push(instead("dispatch", Flux, onDispatch));
        stats.hooked = true;
      } catch (e) {
        console.error("[防撤回] 打补丁失败：", e);
      }
    },
    onUnload() {
      for (const unpatch of unpatches) unpatch();
      unpatches.length = 0;
      userDeleting.clear();
      stats.hooked = false;
    },
    settings: Settings,
  };
})()
