(function () {
  "use strict";

  const DEFAULT_MARKER = "🗑️ 已被删除了喵～";

  const { before, instead } = vendetta.patcher;
  const { findByProps, findByStoreName } = vendetta.metro;

  const unpatches = [];
  const stats = { kept: 0, passed: 0, hooked: false };
  const userDeleting = new Set(); // 你自己点“删除”的消息，照常删除

  let MessageStore = null;
  let UserStore = null;

  // 被删除时加在消息后面的提示；留空表示不加提示
  function readMarker() {
    try {
      const s = vendetta.plugin.storage.marker;
      if (typeof s === "string") return s;
    } catch (e) {}
    return DEFAULT_MARKER;
  }

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
        stats.kept++;
        markDeleted(orig, msg, event.channelId, event.guildId);
        return; // 拦下删除事件，消息就留在屏幕上
      }

      if (type === "MESSAGE_DELETE_BULK") {
        const pass = [];
        for (const id of event.ids || []) {
          const msg = messageToKeep(event.channelId, id);
          if (msg) {
            stats.kept++;
            markDeleted(orig, msg, event.channelId, event.guildId);
          } else {
            stats.passed++;
            pass.push(id);
          }
        }
        if (!pass.length) return;
        return orig({ ...event, ids: pass });
      }
    } catch (e) {
      console.error("[防撤回] 出错，按原样处理：", e);
    }
    return orig(...args);
  }

  // 插件设置页：改提示文字，看运行状态
  function Settings() {
    const { React, ReactNative: RN } = vendetta.metro.common;
    const Forms = (vendetta.ui && vendetta.ui.components && vendetta.ui.components.Forms) || {};
    const h = React.createElement;
    const [marker, setMarker] = React.useState(() => readMarker());

    const onChange = (v) => {
      const text = typeof v === "string" ? v : (v && v.nativeEvent && v.nativeEvent.text) || "";
      setMarker(text);
      try {
        vendetta.plugin.storage.marker = text;
      } catch (e) {}
    };

    const note = (str) =>
      Forms.FormText
        ? h(Forms.FormText, { style: { marginHorizontal: 16, marginTop: 8 } }, str)
        : h(RN.Text, { style: { margin: 16, color: "#b5bac1" } }, str);

    return h(
      RN.ScrollView,
      { keyboardShouldPersistTaps: "handled" },
      Forms.FormInput
        ? h(Forms.FormInput, { title: "被删除时的提示文字", placeholder: DEFAULT_MARKER, value: marker, onChange: onChange })
        : h(RN.TextInput, {
            value: marker,
            placeholder: DEFAULT_MARKER,
            placeholderTextColor: "#80848e",
            onChangeText: onChange,
            style: { margin: 16, padding: 12, borderRadius: 8, color: "#fff", backgroundColor: "#2b2d31" },
          }),
      note("提示会加在被删除的消息下面。留空则不加提示，只保留消息。改完对之后被删的消息生效。"),
      note(
        "状态：" +
          (stats.hooked ? "已接管消息删除事件" : "没接上") +
          "\n已保留 " +
          stats.kept +
          " 条被删除的消息，放行 " +
          stats.passed +
          " 条（你自己删的、临时消息等）。"
      ),
      note("只在这次打开 Discord 期间有效，重启后被删的消息会消失。")
    );
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