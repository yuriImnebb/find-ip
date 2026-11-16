import { createClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./config.js";

const $ = (selector) => document.querySelector(selector);
const supabase =
  typeof SUPABASE_URL === "string" &&
  SUPABASE_URL.startsWith("https://") &&
  typeof SUPABASE_ANON_KEY === "string" &&
  SUPABASE_ANON_KEY.length > 20
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;
const acceptedImageTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

let currentUser = null;
let profile = null;
let chats = [];
let contacts = [];
let friendRequests = [];
let currentChatId = null;
let authMode = "login";
let toastTimer;
let refreshTimer;
let moderator = false;
let refreshing = false;
let sendingMessage = false;
let loadedUserId = null;

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]);
const initials = (name) => (name?.trim().charAt(0) || "?").toLocaleUpperCase("pt-BR");
const formatTime = (date) => new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(new Date(date));
const formatDate = (date) => new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long" }).format(date);
const themeKey = () => `laco:${currentUser?.id}:theme`;
const consentKey = (userId) => `laco:ip-consent:${userId}`;

function getErrorMessage(error) {
  if (error?.status === 403 && error?.banned) {
    return "O acesso desta rede foi bloqueado pela moderação.";
  }
  if (error?.status === 401) {
    return "Sua sessão expirou. Entre novamente.";
  }
  if (error?.status === 428) return error.message;
  return error?.message || "Ocorreu um erro. Tente novamente.";
}

function showToast(message, kind = "") {
  const toast = $("#toast");
  toast.textContent = message;
  toast.className = `toast visible${kind ? ` ${kind}` : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 4500);
}

function setAuthMessage(text = "", kind = "") {
  const message = $("#auth-message");
  message.textContent = text;
  message.className = `form-message${kind ? ` ${kind}` : ""}`;
}

function showAuth(mode = "login", message = "", kind = "") {
  authMode = mode;
  $("#auth-screen").classList.remove("hidden");
  $("#app-screen").classList.add("hidden");
  const consentOnly = mode === "consent";
  const registering = mode === "register";
  $("#auth-eyebrow").textContent = consentOnly ? "ANTES DE CONTINUAR" : registering ? "SEU CANTINHO COMEÇA AQUI" : "QUE BOM TER VOCÊ AQUI";
  $("#auth-title").textContent = consentOnly ? "Revise o aviso de privacidade." : registering ? "Crie seu laço." : "Entre no seu laço.";
  $("#auth-description").textContent = consentOnly ? "Para proteger o serviço, o servidor registra o IP desta rede quando você usa sua conta." : registering ? "É rapidinho. Sua gente já está por aqui." : "Entre para encontrar sua gente.";
  $("#auth-submit").innerHTML = consentOnly ? 'Continuar <span aria-hidden="true">→</span>' : registering ? 'Criar minha conta <span aria-hidden="true">→</span>' : 'Entrar <span aria-hidden="true">→</span>';
  $("#auth-switch-copy").textContent = registering ? "Já tem uma conta?" : "Ainda não tem uma conta?";
  $("#auth-switch-button").textContent = registering ? "Fazer login" : "Criar conta";
  $("#email-field").classList.toggle("hidden", consentOnly);
  $("#password-field").classList.toggle("hidden", consentOnly);
  $("#auth-switch").classList.toggle("hidden", consentOnly);
  $("#name-field").classList.toggle("hidden", !registering);
  $("#auth-name").required = registering;
  $("#auth-email").required = !consentOnly;
  $("#auth-password").required = !consentOnly;
  $("#auth-password").autocomplete = registering ? "new-password" : "current-password";
  $("#auth-password").placeholder = registering ? "Pelo menos 6 caracteres" : "Sua senha";
  $("#ip-consent").checked = false;
  setAuthMessage(message, kind);
}

function userName() {
  return profile?.display_name || currentUser?.user_metadata?.name || currentUser?.email?.split("@")[0] || "";
}

function userHandle(user) {
  const name = user?.display_name || "Pessoa usuária";
  return user?.discriminator ? `${name}#${String(user.discriminator).padStart(6, "0")}` : name;
}

async function apiRequest(path, { method = "GET", body, file, field = "photo" } = {}) {
  const { data: { session }, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  if (!session?.access_token) throw Object.assign(new Error("Entre na sua conta para continuar."), { status: 401 });
  const headers = { Authorization: `Bearer ${session.access_token}` };
  let requestBody;
  if (file) {
    requestBody = new FormData();
    requestBody.append(field, file);
    if (body && typeof body === "object") {
      for (const [key, value] of Object.entries(body)) requestBody.append(key, value);
    }
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    requestBody = JSON.stringify(body);
  }
  const response = await fetch(path, { method, headers, body: requestBody });
  if (response.status === 204) return null;
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || `A solicitação falhou (${response.status}).`);
    error.status = response.status;
    error.banned = Boolean(result.banned);
    if (error.banned) {
      clearInterval(refreshTimer);
      await supabase.auth.signOut();
      currentUser = null;
      loadedUserId = null;
      showAuth("login", getErrorMessage(error), "error");
    }
    throw error;
  }
  return result;
}

async function checkNetworkAccess() {
  const response = await fetch("/api/access");
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.allowed) {
    const error = new Error(result.error || "Esta rede não tem acesso ao laço.");
    error.status = response.status;
    error.banned = Boolean(result.banned);
    throw error;
  }
}

async function showApp(user) {
  if (loadedUserId === user.id && !$("#app-screen").classList.contains("hidden")) return;
  loadedUserId = user.id;
  currentUser = user;
  $("#auth-screen").classList.add("hidden");
  $("#app-screen").classList.remove("hidden");
  $("#topbar-date").textContent = formatDate(new Date()).toLocaleUpperCase("pt-BR");
  document.body.dataset.theme = localStorage.getItem(themeKey()) === "escuro" ? "escuro" : "claro";
  try {
    await refreshData({ changeView: false });
    renderPage("conversas");
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (!document.hidden && !refreshing) refreshData().catch((error) => showToast(getErrorMessage(error), "error"));
    }, 12000);
  } catch (error) {
    await supabase.auth.signOut();
    currentUser = null;
    loadedUserId = null;
    clearInterval(refreshTimer);
    if (error.status === 428) localStorage.removeItem(consentKey(user.id));
    showAuth("login", getErrorMessage(error), "error");
  }
}

async function refreshData({ preserveChat = true, changeView = true } = {}) {
  if (refreshing) return;
  refreshing = true;
  const previousChatId = preserveChat ? currentChatId : null;
  const currentView = document.querySelector(".page-view:not(.hidden)")?.id.replace("view-", "") || "conversas";
  try {
    const data = await apiRequest("/api/bootstrap");
    profile = data.profile;
    contacts = data.contacts || [];
    friendRequests = data.friend_requests || [];
    moderator = Boolean(data.moderator);
    chats = (data.conversations || []).map(mapConversation);
    $("#moderation-nav").classList.toggle("hidden", !moderator);
    renderProfileSummary();
    renderConversationList();
    renderSidebarGroups();
    const chat = chats.find((entry) => entry.id === previousChatId);
    if (chat) await openChat(chat.id);
    if (changeView) renderPage(currentView);
  } finally {
    refreshing = false;
  }
}

function mapConversation(conversation) {
  const members = conversation.members || [];
  const otherMember = members.find((member) => member.id !== currentUser.id);
  return {
    id: conversation.id,
    type: conversation.type === "group" ? "group" : "friend",
    name: conversation.type === "group" ? conversation.title : userHandle(otherMember),
    avatarUrl: conversation.type === "direct" ? otherMember?.avatar_url : null,
    avatarText: conversation.type === "group" ? "▦" : initials(otherMember?.display_name || "A"),
    members,
    messages: conversation.messages || [],
    lastMessage: conversation.last_message || "",
    updatedAt: conversation.updated_at,
  };
}

function renderProfileSummary() {
  const name = userName();
  $("#profile-name").textContent = name || currentUser.email;
  $("#profile-avatar").textContent = initials(name);
  $("#top-profile").textContent = initials(name);
  $("#welcome-name").textContent = name.split(" ")[0] || "pessoa querida";
  setAvatarImage($("#profile-avatar"), profile?.avatar_url);
  setAvatarImage($("#top-profile"), profile?.avatar_url);
}

function setAvatarImage(element, url) {
  element.style.backgroundImage = url ? `url("${url}")` : "";
  element.classList.toggle("avatar-photo", Boolean(url));
}

function renderConversationList(filter = $("#search-input").value.trim().toLocaleLowerCase("pt-BR")) {
  const filtered = chats.filter((chat) => `${chat.name} ${chat.lastMessage}`.toLocaleLowerCase("pt-BR").includes(filter));
  $("#conversation-list").innerHTML = filtered.length
    ? filtered.map((chat) => `
      <button class="conversation-item${chat.id === currentChatId ? " selected" : ""}" type="button" data-chat-id="${escapeHtml(chat.id)}">
        <span class="avatar ${chat.type === "group" ? "avatar-mint" : ""}${chat.avatarUrl ? " avatar-photo" : ""}" ${chat.avatarUrl ? `style="background-image:url('${escapeHtml(chat.avatarUrl)}')"` : ""}>${chat.avatarUrl ? "" : escapeHtml(chat.avatarText)}</span>
        <span class="conversation-copy"><strong>${escapeHtml(chat.name)}</strong><small>${escapeHtml(chat.lastMessage)}</small></span>
        <span class="conversation-meta"><small>${chat.updatedAt ? escapeHtml(formatTime(chat.updatedAt)) : ""}</small>${chat.type === "group" ? '<span class="group-indicator" aria-label="Grupo">♧</span>' : ""}</span>
      </button>`).join("")
    : '<div class="list-empty">Nenhuma conversa ainda. Adicione um amigo para começar.</div>';
}

function renderSidebarGroups() {
  const groups = chats.filter((chat) => chat.type === "group");
  $("#sidebar-groups").innerHTML = groups.length
    ? groups.map((group) => `<button class="sidebar-group" type="button" data-chat-id="${escapeHtml(group.id)}"><span class="group-dot">${escapeHtml(group.avatarText)}</span><span>${escapeHtml(group.name)}</span></button>`).join("")
    : '<p class="sidebar-empty">Nenhum grupo ainda.</p>';
}

async function openChat(chatId) {
  const chat = chats.find((item) => item.id === chatId);
  if (!chat) return;
  currentChatId = chat.id;
  $("#chat-empty").classList.add("hidden");
  $("#chat-active").classList.remove("hidden");
  $("#chat-avatar").textContent = chat.avatarUrl ? "" : chat.avatarText;
  $("#chat-avatar").className = `avatar${chat.type === "group" ? " avatar-mint" : ""}`;
  setAvatarImage($("#chat-avatar"), chat.avatarUrl);
  $("#chat-name").textContent = chat.name;
  const otherMember = chat.members.find((member) => member.id !== currentUser.id);
  $("#chat-status").textContent = chat.type === "group"
    ? `${chat.members.length} participantes`
    : (otherMember?.bio || "conversa privada");
  const profileLink = $("#chat-profile-link");
  profileLink.classList.toggle("hidden", !otherMember?.profile_link);
  if (otherMember?.profile_link) {
    profileLink.href = otherMember.profile_link;
    profileLink.textContent = otherMember.profile_link.replace(/^https?:\/\//, "");
  } else {
    profileLink.removeAttribute("href");
    profileLink.textContent = "";
  }
  renderMessages(chat);
  renderConversationList();
  if (window.matchMedia("(max-width: 760px)").matches) $("#view-conversas").classList.add("chat-open");
}

function renderMessages(chat) {
  const container = $("#chat-messages");
  container.innerHTML = "";
  for (const message of chat.messages) {
    const mine = message.sender_id === currentUser.id;
    const sender = chat.members.find((member) => member.id === message.sender_id);
    const row = document.createElement("div");
    row.className = `message-row${mine ? " mine" : ""}`;
    if (mine || sender) {
        const author = document.createElement("small");
      author.className = "message-author";
        author.textContent = mine ? "Você" : userHandle(sender);
      row.append(author);
    }
    if (message.body) {
      const bubble = document.createElement("div");
      bubble.className = "message-bubble";
      bubble.textContent = message.body;
      row.append(bubble);
    }
    if (message.photo_url) {
      const photo = document.createElement("img");
      photo.className = "message-photo";
      photo.alt = "Foto enviada na conversa";
      photo.loading = "lazy";
      photo.src = message.photo_url;
      row.append(photo);
    }
    const time = document.createElement("small");
    time.className = "message-time";
    time.textContent = message.pending ? "enviando..." : formatTime(message.created_at);
    if (message.pending) row.classList.add("pending");
    row.append(time);
    container.append(row);
  }
  container.scrollTop = container.scrollHeight;
}

function renderPage(view) {
  if (view === "moderacao" && !moderator) return;
  document.querySelectorAll(".page-view").forEach((page) => page.classList.add("hidden"));
  const page = $(`#view-${view}`);
  if (!page) return;
  page.classList.remove("hidden");
  document.querySelectorAll(".nav-item[data-view]").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  const titles = {
    conversas: "Suas conversas",
    amigos: "Amigos e contatos",
    grupos: "Seus grupos",
    configuracoes: "Suas configurações",
    perfil: "Seu perfil",
    moderacao: "Moderação de rede",
  };
  $("#topbar-title").textContent = titles[view] || titles.conversas;
  if (view === "amigos") renderFriendsPage();
  if (view === "grupos") renderGroupsPage();
  if (view === "configuracoes") renderSettingsPage();
  if (view === "perfil") renderProfilePage();
  if (view === "moderacao") loadModerationPage().catch((error) => showToast(getErrorMessage(error), "error"));
  closeSidebar();
}

function getFriends() {
  const unique = new Map();
  for (const request of friendRequests) {
    if (request.status !== "accepted") continue;
    const friend = request.sender_id === currentUser.id ? request.recipient : request.sender;
    if (friend && friend.id !== currentUser.id) unique.set(friend.id, friend);
  }
  return [...unique.values()];
}

function getIncomingRequests() {
  return friendRequests.filter((request) => request.recipient_id === currentUser.id && request.status === "pending");
}

function getOutgoingRequests() {
  return friendRequests.filter((request) => request.sender_id === currentUser.id && request.status === "pending");
}

function renderFriendsPage() {
  const friends = getFriends();
  const incoming = getIncomingRequests();
  const outgoing = getOutgoingRequests();
  $("#view-amigos").innerHTML = `
    <div class="section-intro"><span class="eyebrow">GENTE QUERIDA</span><h1>Amigos <span>♡</span></h1><p>Encontre cada pessoa pelo apelido e identificador exclusivo.</p></div>
    <section class="panel directory-panel">
      <div class="panel-heading"><div><span class="eyebrow">ADICIONAR PELO IDENTIFICADOR</span><h2>Encontre seu amigo</h2></div></div>
      <p class="privacy-note">Peça o identificador completo da pessoa, no formato <strong>apelido#123456</strong>. Apelidos podem se repetir; o número diferencia cada conta.</p>
      <form id="add-friend-form" class="inline-form nickname-form">
        <label class="form-field"><span>Apelido#número</span><input name="handle" type="text" maxlength="67" pattern=".{1,60}#[0-9]{6}" placeholder="luna#482731" autocomplete="off" required /></label>
        <button class="button button-primary" type="submit"><svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="10.5" cy="8" r="4"/><path d="M3 21v-1a7.5 7.5 0 0 1 15 0v1M19 8v6M16 11h6"/></svg> Enviar pedido</button>
      </form>
    </section>
    ${incoming.length ? `<section class="panel directory-panel"><div class="panel-heading"><div><span class="eyebrow">NOVAS CONEXÕES</span><h2>Pedidos recebidos</h2></div></div><div class="request-list">${incoming.map((request) => `<div class="request-row"><span><strong>${escapeHtml(userHandle(request.sender))}</strong><small>quer adicionar você</small></span><button class="button button-primary" data-action="accept-request" data-request-id="${escapeHtml(request.id)}" type="button">Aceitar</button><button class="text-button" data-action="decline-request" data-request-id="${escapeHtml(request.id)}" type="button">Recusar</button></div>`).join("")}</div></section>` : ""}
    ${outgoing.length ? `<section class="panel directory-panel"><div class="panel-heading"><div><span class="eyebrow">AGUARDANDO RESPOSTA</span><h2>Pedidos enviados</h2></div></div><div class="request-list">${outgoing.map((request) => `<div class="request-row"><span><strong>${escapeHtml(userHandle(request.recipient))}</strong><small>pedido pendente</small></span></div>`).join("")}</div></section>` : ""}
    <section class="panel directory-panel"><div class="panel-heading"><div><span class="eyebrow">CONEXÕES CONFIRMADAS</span><h2>${friends.length} ${friends.length === 1 ? "amigo" : "amigos"}</h2></div></div>
      <div class="directory-grid">${friends.map((friend) => `<button class="person-card" type="button" data-friend-id="${escapeHtml(friend.id)}"><span class="avatar${friend.avatar_url ? " avatar-photo" : ""}" ${friend.avatar_url ? `style="background-image:url('${escapeHtml(friend.avatar_url)}')"` : ""}>${friend.avatar_url ? "" : escapeHtml(initials(friend.display_name))}</span><strong>${escapeHtml(userHandle(friend))}</strong><small>Amizade confirmada</small><span class="person-open">Abrir conversa →</span></button>`).join("") || '<p class="list-empty">Seus amigos aparecerão aqui quando aceitarem o pedido.</p>'}</div>
    </section>`;
}

function renderGroupsPage() {
  const groups = chats.filter((chat) => chat.type === "group");
  const friends = getFriends();
  $("#view-grupos").innerHTML = `
    <div class="section-intro"><span class="eyebrow">A TURMA TODA</span><h1>Grupos <span>✳</span></h1><p>Conversas em grupo sincronizadas na sua conta.</p></div>
    <section class="panel directory-panel"><div class="panel-heading"><div><span class="eyebrow">SEUS CANTINHOS</span><h2>${groups.length} ${groups.length === 1 ? "grupo" : "grupos"}</h2></div></div>
      <form id="create-group-form" class="group-form"><label class="form-field"><span>Nome do grupo</span><input name="title" type="text" maxlength="80" placeholder="Ex.: turma da escola" required /></label><fieldset class="friend-picker"><legend>Escolha os amigos</legend>${friends.map((friend) => `<label><input type="checkbox" name="members" value="${escapeHtml(friend.id)}" /> ${escapeHtml(friend.display_name || "Pessoa usuária")}</label>`).join("") || "<small>Vocês precisam aceitar o convite de amizade antes de criar um grupo.</small>"}</fieldset><button class="button button-primary" type="submit" ${friends.length ? "" : "disabled"}>Criar grupo</button></form>
      <div class="directory-grid">${groups.map((group) => `<button class="person-card group-card" type="button" data-chat-id="${escapeHtml(group.id)}"><span class="avatar avatar-mint">▦</span><strong>${escapeHtml(group.name)}</strong><small>${group.members.length} participantes · ${escapeHtml(group.lastMessage)}</small><span class="person-open">Abrir grupo →</span></button>`).join("") || '<p class="list-empty">Você ainda não participa de grupos.</p>'}</div>
    </section>`;
}

function renderSettingsPage() {
  $("#view-configuracoes").innerHTML = `
    <div class="section-intro"><span class="eyebrow">DO SEU JEITO</span><h1>Configurações <span>☼</span></h1><p>Gerencie seu perfil e a aparência do app.</p></div>
    <section class="panel settings-panel"><div class="settings-heading"><span class="settings-symbol">☻</span><div><h2>Seu perfil</h2><p>Como as pessoas conhecem você.</p></div><button class="text-button" data-action="open-profile" type="button">Editar →</button></div>
      <div class="settings-row"><div><strong>Nome</strong><small>${escapeHtml(userName())}</small></div><span>✳</span></div>
      <div class="settings-row"><div><strong>E-mail</strong><small>${escapeHtml(currentUser?.email || "")}</small></div><span>✓</span></div>
    </section>
    <section class="panel settings-panel"><div class="settings-heading"><span class="settings-symbol">◐</span><div><h2>Aparência</h2><p>Escolha o clima do seu cantinho.</p></div></div>
      <div class="theme-options">
        <button class="theme-option" data-theme-choice="claro" type="button"><span class="theme-preview preview-light">Aa</span><strong>Claro</strong><small>branco e preto</small><span class="theme-check">✓</span></button>
        <button class="theme-option" data-theme-choice="escuro" type="button"><span class="theme-preview preview-dark">Aa</span><strong>Escuro</strong><small>inverte as cores</small><span class="theme-check">✓</span></button>
      </div>
    </section>`;
  updateThemeControls();
}

function renderProfilePage() {
  const name = userName();
  $("#view-perfil").innerHTML = `
    <div class="section-intro"><span class="eyebrow">SEU ESPAÇO PESSOAL</span><h1>Seu perfil <span>♡</span></h1><p>Seu perfil e sua foto na sua conta.</p></div>
    <section class="panel profile-panel"><label class="avatar avatar-profile profile-large profile-upload${profile?.avatar_url ? " avatar-photo" : ""}" style="${profile?.avatar_url ? `background-image:url('${escapeHtml(profile.avatar_url)}')` : ""}" for="profile-photo" id="profile-photo-preview">${profile?.avatar_url ? "" : escapeHtml(initials(name))}</label><input id="profile-photo" class="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp,image/gif" /><button class="text-button profile-photo-button" type="button" data-action="choose-profile-photo">Alterar foto</button><h2>${escapeHtml(name)}</h2><p>${escapeHtml(currentUser?.email || "")}</p><div class="profile-handle"><span>Seu identificador</span><strong>${escapeHtml(userHandle(profile))}</strong><button class="icon-button" type="button" data-action="copy-handle" aria-label="Copiar identificador" title="Copiar identificador"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg></button></div><form id="profile-form" class="profile-edit-form"><label class="form-field"><span>Seu apelido</span><input name="display_name" maxlength="60" value="${escapeHtml(name)}" required /></label><label class="form-field"><span>Biografia</span><textarea name="bio" maxlength="160" rows="3" placeholder="Um pouco sobre você...">${escapeHtml(profile?.bio || "")}</textarea></label><label class="form-field"><span>Link do perfil</span><input name="profile_link" type="url" maxlength="200" value="${escapeHtml(profile?.profile_link || "")}" placeholder="https://instagram.com/seu-usuario" /></label><button class="button button-primary" type="submit"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg> Salvar perfil</button></form>${profile?.profile_link ? `<a class="profile-link" href="${escapeHtml(profile.profile_link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(profile.profile_link.replace("https://", "").replace("http://", ""))}</a>` : ""}<span class="profile-badge">o número é exclusivo e não pode ser alterado</span></section>`;
}

async function loadModerationPage() {
  if (!moderator) return;
  const data = await apiRequest("/api/admin/moderation");
  const messagesByUser = new Map(data.addresses.map((entry) => [entry.user_id, Number(entry.message_count || 0)]));
  const totalMessages = [...messagesByUser.values()].reduce((sum, count) => sum + count, 0);
  $("#view-moderacao").innerHTML = `
    <div class="section-intro moderation-intro"><span class="eyebrow">PAINEL PRIVADO · ACESSO RESTRITO</span><h1>Moderação <span>⚑</span></h1><p>Gerencie acessos e investigue atividade. Mensagens privadas e destinatários não são exibidos.</p><button class="button button-soft" data-action="refresh-moderation" type="button">Atualizar dados ↻</button></div>
    <div class="admin-stats">
      <article class="panel admin-stat"><span class="admin-stat-icon">♙</span><small>CONTAS COM IP REGISTRADO</small><strong>${new Set(data.addresses.map((entry) => entry.user_id)).size}</strong></article>
      <article class="panel admin-stat"><span class="admin-stat-icon">▣</span><small>ENDEREÇOS REGISTRADOS</small><strong>${data.addresses.length}</strong></article>
      <article class="panel admin-stat"><span class="admin-stat-icon">↗</span><small>MENSAGENS ENVIADAS</small><strong>${totalMessages}</strong><small>total por conta; sem conteúdo ou destinatários</small></article>
      <article class="panel admin-stat"><span class="admin-stat-icon">⊘</span><small>IPS BLOQUEADOS</small><strong>${data.bans.length}</strong></article>
    </div>
    <section class="panel directory-panel">
      <div class="panel-heading"><div><span class="eyebrow">USUÁRIOS E CONEXÕES</span><h2>Atividade das contas</h2></div>
        <label class="admin-search"><span aria-hidden="true">⌕</span><input id="moderation-search" type="search" placeholder="Buscar por nome ou IP" aria-label="Buscar usuários por nome ou IP" /></label>
      </div>
      <p class="privacy-note">Os IPs são dados pessoais. São mostrados apenas a moderadores autorizados; use-os com responsabilidade. Conversas e destinatários permanecem privados.</p>
      <div class="moderation-table-wrap"><table class="moderation-table"><thead><tr><th>Conta</th><th>IP</th><th>Mensagens</th><th>Último acesso</th><th>Moderação</th></tr></thead>
      <tbody>${data.addresses.map((entry) => `<tr data-user="${escapeHtml(`${entry.display_name} ${normalizeIp(entry.ip_address)}`.toLocaleLowerCase("pt-BR"))}">
        <td><span class="admin-user">${entry.avatar_url ? `<img class="admin-avatar" src="${escapeHtml(entry.avatar_url)}" alt="" loading="lazy" />` : `<span class="admin-avatar admin-avatar-placeholder">${escapeHtml(initials(entry.display_name))}</span>`}<span><strong>${escapeHtml(entry.display_name)}</strong><small>${escapeHtml(entry.user_id)}</small></span></span></td>
        <td><code>${escapeHtml(normalizeIp(entry.ip_address))}</code></td>
        <td><strong>${Number(entry.message_count || 0)}</strong>${entry.last_message_at ? `<small class="admin-subline">última: ${escapeHtml(new Date(entry.last_message_at).toLocaleString("pt-BR"))}</small>` : '<small class="admin-subline">nenhuma</small>'}</td>
        <td>${escapeHtml(new Date(entry.last_seen_at).toLocaleString("pt-BR"))}</td>
        <td><form class="ban-form" data-ip="${escapeHtml(normalizeIp(entry.ip_address))}"><input name="reason" maxlength="300" placeholder="Motivo do banimento" required /><button class="button button-primary" type="submit">Banir IP</button></form></td>
      </tr>`).join("") || '<tr><td colspan="5" class="list-empty">Nenhum endereço registrado.</td></tr>'}</tbody></table></div>
    </section>
    <section class="panel directory-panel"><div class="panel-heading"><div><span class="eyebrow">BLOQUEIOS PERMANENTES</span><h2>${data.bans.length} IP bloqueados</h2></div></div>
      <div class="contact-list">${data.bans.map((ban) => `<div class="contact-row"><span><code>${escapeHtml(normalizeIp(ban.ip_address))}</code><small>${escapeHtml(ban.reason)} · ${escapeHtml(new Date(ban.created_at).toLocaleString("pt-BR"))}</small></span><button class="button button-soft" data-action="unban-ip" data-ban-id="${escapeHtml(ban.id)}" type="button">Desbloquear</button></div>`).join("") || '<p class="list-empty">Nenhum endereço bloqueado.</p>'}</div>
    </section>`;
}

function normalizeIp(value) {
  return String(value || "").replace(/\/(?:32|128)$/, "");
}

function updateThemeControls() {
  const theme = document.body.dataset.theme || "claro";
  $("#theme-icon").textContent = theme === "escuro" ? "☼" : "☾";
  document.querySelectorAll("[data-theme-choice]").forEach((button) => button.classList.toggle("chosen", button.dataset.themeChoice === theme));
}

function setTheme(theme) {
  if (!["claro", "escuro"].includes(theme)) return;
  document.body.dataset.theme = theme;
  localStorage.setItem(themeKey(), theme);
  updateThemeControls();
}

function closeSidebar() {
  $("#sidebar").classList.remove("open");
  $("#sidebar-overlay").classList.remove("visible");
}

async function sendFriendRequest(handle) {
  const data = await apiRequest("/api/friend-requests", {
    method: "POST",
    body: { handle: handle.trim() },
  });
  if (data.status === "self") showToast("Esse identificador é da sua própria conta.", "error");
  else if (data.status === "already_friends") showToast("Essa pessoa já é sua amiga.");
  else if (data.status === "already_requested") showToast("O pedido para essa pessoa já está pendente.");
  else if (data.status === "incoming_pending") {
    showToast("Essa pessoa já enviou um pedido para você. Confira os pedidos recebidos.");
  } else if (data.status === "not_found") showToast("Não encontrei esse apelido e número. Confira o identificador.", "error");
  else showToast("Pedido enviado! Agora é só esperar a resposta.");
}

async function respondToRequest(requestId, accept) {
  await apiRequest(`/api/friend-requests/${encodeURIComponent(requestId)}/respond`, {
    method: "POST",
    body: { accept },
  });
  await refreshData();
  showToast(accept ? "Amizade confirmada! Vocês já podem conversar." : "Pedido recusado.");
}

async function openFriendConversation(friendId) {
  const { id } = await apiRequest("/api/conversations/direct", { method: "POST", body: { user_id: friendId } });
  await refreshData({ preserveChat: false });
  renderPage("conversas");
  await openChat(id);
}

async function createGroup(form) {
  const data = new FormData(form);
  await apiRequest("/api/conversations/groups", {
    method: "POST",
    body: {
      title: String(data.get("title") || "").trim(),
      member_ids: data.getAll("members").map(String),
    },
  });
  await refreshData({ preserveChat: false });
  renderPage("grupos");
  showToast("Grupo criado e salvo no Supabase.");
}

async function sendMessage(text, photoFile) {
  if (!currentChatId) throw new Error("Escolha uma conversa antes de enviar uma mensagem.");
  if (!text && !photoFile) return;
  if (sendingMessage) throw new Error("Aguarde o envio da mensagem anterior.");
  if (text.length > 4000) throw new Error("A mensagem deve ter no máximo 4.000 caracteres.");
  if (photoFile && !acceptedImageTypes.has(photoFile.type)) {
    throw new Error("Escolha uma foto JPG, PNG, WebP ou GIF.");
  }
  const chat = chats.find((entry) => entry.id === currentChatId);
  if (!chat) throw new Error("Essa conversa não está mais disponível.");
  const localId = `pending-${crypto.randomUUID()}`;
  const photoUrl = photoFile ? URL.createObjectURL(photoFile) : null;
  const previousLastMessage = chat.lastMessage;
  const previousUpdatedAt = chat.updatedAt;
  const optimisticMessage = {
    id: localId,
    sender_id: currentUser.id,
    body: text,
    photo_url: photoUrl,
    created_at: new Date().toISOString(),
    pending: true,
  };
  chat.messages.push(optimisticMessage);
  chat.lastMessage = text || (photoFile ? "📷 Foto" : "");
  chat.updatedAt = optimisticMessage.created_at;
  sendingMessage = true;
  renderMessages(chat);
  renderConversationList();
  const input = $("#message-input");
  if (input.value === text) input.value = "";
  try {
    const savedMessage = await apiRequest(`/api/conversations/${encodeURIComponent(chat.id)}/messages`, {
      method: "POST",
      body: { body: text },
      file: photoFile || null,
      field: "photo",
    });
    const messageIndex = chat.messages.findIndex((message) => message.id === localId);
    if (messageIndex !== -1) chat.messages.splice(messageIndex, 1, savedMessage);
    chat.lastMessage = text || (photoFile ? "📷 Foto" : "");
    chat.updatedAt = savedMessage.created_at;
    renderMessages(chat);
    renderConversationList();
    if ($("#message-photo").files[0] === photoFile) $("#message-photo").value = "";
    $("#message-input").placeholder = "Escreva uma mensagem...";
    if (photoUrl) URL.revokeObjectURL(photoUrl);
  } catch (error) {
    chat.messages = chat.messages.filter((message) => message.id !== localId);
    chat.lastMessage = previousLastMessage;
    chat.updatedAt = previousUpdatedAt;
    renderMessages(chat);
    renderConversationList();
    if (input.value === "" && text) input.value = text;
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    throw error;
  } finally {
    sendingMessage = false;
  }
}

async function saveProfile(form) {
  const data = new FormData(form);
  profile = await apiRequest("/api/profile", {
    method: "PUT",
    body: {
      display_name: String(data.get("display_name") || "").trim(),
      bio: String(data.get("bio") || "").trim(),
      profile_link: String(data.get("profile_link") || "").trim(),
    },
  });
  renderProfileSummary();
  renderPage("perfil");
  showToast("Perfil atualizado.");
}

async function saveProfilePhoto(file) {
  profile = await apiRequest("/api/profile/photo", { method: "POST", file, field: "photo" });
  renderProfileSummary();
  renderPage("perfil");
  showToast("Foto de perfil salva no Supabase.");
}

async function banIp(form) {
  const ip = form.dataset.ip;
  const reason = String(new FormData(form).get("reason") || "").trim();
  if (!window.confirm(`Banir permanentemente o IP ${ip}? Pessoas que compartilham esta rede também podem perder acesso.`)) return;
  await apiRequest("/api/admin/ip-bans", { method: "POST", body: { ip_address: ip, reason } });
  await loadModerationPage();
  showToast(`IP ${ip} bloqueado permanentemente.`);
}

$("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!supabase) {
    setAuthMessage("Configure as variáveis públicas do Supabase para entrar.", "error");
    return;
  }
  const email = $("#auth-email").value.trim();
  const password = $("#auth-password").value;
  if (!$("#ip-consent").checked) {
    setAuthMessage("Confirme que leu o aviso sobre o registro de IP para continuar.", "error");
    return;
  }
  const button = $("#auth-submit");
  button.disabled = true;
  button.textContent = authMode === "consent" ? "Salvando..." : authMode === "register" ? "Criando sua conta..." : "Entrando...";
  setAuthMessage();
  try {
    await checkNetworkAccess();
    if (authMode === "consent") {
      await apiRequest("/api/consent", { method: "POST", body: { accepted: true } });
      localStorage.setItem(consentKey(currentUser.id), "yes");
      await showApp(currentUser);
    } else if (authMode === "register") {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { name: $("#auth-name").value.trim() }, emailRedirectTo: window.location.origin },
      });
      if (error) throw error;
      if (data.session && data.user) {
        await supabase.auth.signOut();
      }
      $("#auth-form").reset();
      showAuth("login", "Conta criada! Confirme seu e-mail pelo link enviado e depois faça login.", "success");
    } else {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      currentUser = data.user;
      try {
        await apiRequest("/api/consent", { method: "POST", body: { accepted: true } });
      } catch (consentError) {
        await supabase.auth.signOut();
        currentUser = null;
        throw consentError;
      }
      localStorage.setItem(consentKey(data.user.id), "yes");
      await showApp(data.user);
    }
  } catch (error) {
    setAuthMessage(getErrorMessage(error), "error");
  } finally {
    button.disabled = false;
    button.innerHTML = authMode === "consent" ? 'Continuar <span aria-hidden="true">→</span>' : authMode === "register" ? 'Criar minha conta <span aria-hidden="true">→</span>' : 'Entrar <span aria-hidden="true">→</span>';
  }
});

$("#auth-switch-button").addEventListener("click", () => showAuth(authMode === "login" ? "register" : "login"));
$("#search-input").addEventListener("input", (event) => renderConversationList(event.target.value.trim().toLocaleLowerCase("pt-BR")));
$("#conversation-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-chat-id]");
  if (button) openChat(button.dataset.chatId);
});
$("#sidebar-groups").addEventListener("click", (event) => {
  const button = event.target.closest("[data-chat-id]");
  if (button) {
    renderPage("conversas");
    openChat(button.dataset.chatId);
  }
});
$("#message-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  if (button) button.disabled = true;
  try {
    await sendMessage($("#message-input").value.trim(), $("#message-photo").files[0] || null);
  } catch (error) {
    showToast(getErrorMessage(error), "error");
  } finally {
    if (button) button.disabled = false;
  }
});
$("#message-photo").addEventListener("change", () => {
  const file = $("#message-photo").files[0];
  if (file) $("#message-input").placeholder = `Foto pronta: ${file.name}`;
});
$("#back-to-list").addEventListener("click", () => $("#view-conversas").classList.remove("chat-open"));
$("#new-friend-button").addEventListener("click", () => renderPage("amigos"));
$("#empty-new-friend").addEventListener("click", () => renderPage("amigos"));
$("#add-group-shortcut").addEventListener("click", () => renderPage("grupos"));
$("#mobile-menu").addEventListener("click", () => {
  $("#sidebar").classList.add("open");
  $("#sidebar-overlay").classList.add("visible");
});
$("#mobile-close").addEventListener("click", closeSidebar);
$("#sidebar-overlay").addEventListener("click", closeSidebar);
$("#theme-toggle").addEventListener("click", () => {
  setTheme(document.body.dataset.theme === "escuro" ? "claro" : "escuro");
});
$("#top-profile").addEventListener("click", () => renderPage("perfil"));
$("#my-profile").addEventListener("click", () => renderPage("perfil"));
$("#signout-button").addEventListener("click", async () => {
  clearInterval(refreshTimer);
  const signedOutUserId = currentUser?.id;
  const { error } = await supabase.auth.signOut();
  if (error) {
    showToast(error.message, "error");
    return;
  }
  currentUser = null;
  loadedUserId = null;
  if (signedOutUserId) localStorage.removeItem(consentKey(signedOutUserId));
  profile = null;
  moderator = false;
  chats = [];
  contacts = [];
  showAuth("login", "Você saiu da sua conta.", "success");
});
$("#view-amigos").addEventListener("click", async (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  const requestId = event.target.closest("[data-request-id]")?.dataset.requestId;
  const friendId = event.target.closest("[data-friend-id]")?.dataset.friendId;
  try {
    if (action === "accept-request" && requestId) await respondToRequest(requestId, true);
    if (action === "decline-request" && requestId) await respondToRequest(requestId, false);
    if (friendId) await openFriendConversation(friendId);
  } catch (error) {
    showToast(getErrorMessage(error), "error");
  }
});
$("#view-amigos").addEventListener("submit", async (event) => {
  if (event.target.id !== "add-friend-form") return;
  event.preventDefault();
  const data = new FormData(event.target);
  try {
    await sendFriendRequest(String(data.get("handle") || ""));
    await refreshData();
    event.target.reset();
  } catch (error) {
    showToast(getErrorMessage(error), "error");
  }
});
$("#view-perfil").addEventListener("click", async (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "choose-profile-photo") {
    $("#profile-photo").click();
    return;
  }
  if (action === "copy-handle") {
    try {
      await navigator.clipboard.writeText(userHandle(profile));
      showToast("Identificador copiado.");
    } catch (error) {
      showToast(`Não foi possível copiar o identificador: ${getErrorMessage(error)}`, "error");
    }
  }
});
$("#view-grupos").addEventListener("click", (event) => {
  const button = event.target.closest("[data-chat-id]");
  if (button) openChat(button.dataset.chatId);
});
$("#view-grupos").addEventListener("submit", async (event) => {
  if (event.target.id !== "create-group-form") return;
  event.preventDefault();
  try {
    await createGroup(event.target);
  } catch (error) {
    showToast(getErrorMessage(error), "error");
  }
});
$("#view-configuracoes").addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "open-profile") renderPage("perfil");
  const theme = event.target.closest("[data-theme-choice]")?.dataset.themeChoice;
  if (theme) setTheme(theme);
});
$("#view-perfil").addEventListener("submit", async (event) => {
  if (event.target.id !== "profile-form") return;
  event.preventDefault();
  try {
    await saveProfile(event.target);
  } catch (error) {
    showToast(getErrorMessage(error), "error");
  }
});
$("#view-perfil").addEventListener("change", async (event) => {
  if (event.target.id !== "profile-photo") return;
  const file = event.target.files[0];
  if (!file) return;
  try {
    await saveProfilePhoto(file);
  } catch (error) {
    showToast(getErrorMessage(error), "error");
  }
});
$("#view-moderacao").addEventListener("submit", async (event) => {
  if (!event.target.matches(".ban-form")) return;
  event.preventDefault();
  try {
    await banIp(event.target);
  } catch (error) {
    showToast(getErrorMessage(error), "error");
  }
});
$("#view-moderacao").addEventListener("click", async (event) => {
  if (event.target.closest("[data-action='refresh-moderation']")) {
    try {
      await loadModerationPage();
    } catch (error) {
      showToast(getErrorMessage(error), "error");
    }
    return;
  }
  const button = event.target.closest("[data-action='unban-ip']");
  if (!button || !window.confirm("Remover este bloqueio permanente?")) return;
  try {
    await apiRequest(`/api/admin/ip-bans/${encodeURIComponent(button.dataset.banId)}`, { method: "DELETE" });
    await loadModerationPage();
    showToast("Bloqueio removido.");
  } catch (error) {
    showToast(getErrorMessage(error), "error");
  }
});
$("#view-moderacao").addEventListener("input", (event) => {
  if (event.target.id !== "moderation-search") return;
  const term = event.target.value.trim().toLocaleLowerCase("pt-BR");
  $("#view-moderacao").querySelectorAll(".moderation-table tbody tr[data-user]").forEach((row) => {
    row.classList.toggle("hidden", !row.dataset.user.includes(term));
  });
});
document.querySelectorAll(".nav-item[data-view]").forEach((button) => button.addEventListener("click", () => renderPage(button.dataset.view)));

if (supabase) {
  supabase.auth.getSession().then(({ data, error }) => {
    if (error) showAuth("login", `Não foi possível verificar sua sessão: ${error.message}`, "error");
    else if (data.session) {
      currentUser = data.session.user;
      if (localStorage.getItem(consentKey(currentUser.id)) === "yes") showApp(currentUser);
      else showAuth("consent");
    }
    else showAuth();
  });
} else {
  showAuth();
}
