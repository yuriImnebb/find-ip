import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";

const root = dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const moderatorEmails = new Set(
  (process.env.MODERATOR_EMAILS || "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean),
);
const avatarBucket = "avatars";
const photoBucket = "message-photos";
const photoLimit = 10 * 1024 * 1024;
const acceptedImageTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
  throw new Error("Configure SUPABASE_URL, SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY no servidor.");
}

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const authenticator = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "64kb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: photoLimit, files: 1 },
  fileFilter(_req, file, callback) {
    callback(null, acceptedImageTypes.has(file.mimetype));
  },
});

function apiError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function isUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function sendError(res, error) {
  console.error("API request failed:", error);
  if (error instanceof multer.MulterError) {
    const message = error.code === "LIMIT_FILE_SIZE"
      ? "A foto deve ter no máximo 10 MB."
      : "Não foi possível processar o arquivo enviado.";
    return res.status(400).json({ error: message });
  }
  if (error.code === "PGRST205" || error.code === "42P01") {
    return res.status(503).json({
      error: "O banco ainda não tem todas as tabelas necessárias. Reexecute a migration 20261105010000_render_ip_moderation.sql no Supabase e aguarde a atualização do schema.",
    });
  }
  if (error.code === "42501" || error.code === "PGRST301") {
    return res.status(503).json({
      error: "O Supabase negou o acesso do servidor. Confira se as migrations foram aplicadas e se SUPABASE_SERVICE_ROLE_KEY é a chave secreta correta no .env.",
    });
  }
  const message = error.status ? error.message : "Não foi possível concluir a solicitação.";
  return res.status(error.status || 500).json({ error: message });
}

function requireData(result) {
  if (result.error) {
    const error = new Error(result.error.message);
    error.status = result.error.code === "23505" ? 409 : 400;
    throw error;
  }
  return result.data;
}

function trustedClientIp(req) {
  const ip = req.ip;
  if (!ip || !isIP(ip)) throw apiError("Não foi possível verificar o IP de origem da conexão.", 503);
  return ip;
}

async function checkIpBan(ip) {
  const { data, error } = await admin.from("ip_bans").select("id,reason").eq("ip_address", ip).maybeSingle();
  if (error) throw error;
  return data;
}

async function requireUser(req, res, next) {
  try {
    const ip = trustedClientIp(req);
    const ban = await checkIpBan(ip);
    if (ban) return res.status(403).json({ error: "O acesso desta rede foi bloqueado pela moderação.", banned: true });

    const token = req.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) return res.status(401).json({ error: "Entre na sua conta para continuar." });
    const { data, error } = await authenticator.auth.getUser(token);
    if (error || !data.user) return res.status(401).json({ error: "Sua sessão expirou. Entre novamente." });
    if (!data.user.email_confirmed_at) return res.status(403).json({ error: "Confirme seu e-mail antes de usar o app." });

    req.user = data.user;
    req.clientIp = ip;
    if (req.path !== "/access" && req.path !== "/consent") {
      const { data: consent, error: consentError } = await admin.from("ip_consents")
        .select("user_id").eq("user_id", data.user.id).maybeSingle();
      if (consentError) throw consentError;
      if (!consent) return res.status(428).json({ error: "Leia e aceite o aviso de privacidade antes de continuar.", consentRequired: true });
      const { error: recordError } = await admin.from("user_ip_addresses").upsert(
        { user_id: data.user.id, ip_address: ip, last_seen_at: new Date().toISOString() },
        { onConflict: "user_id,ip_address", ignoreDuplicates: false },
      );
      if (recordError) throw recordError;
    }
    return next();
  } catch (error) {
    return sendError(res, error);
  }
}

function requireModerator(req, _res, next) {
  if (!req.user?.email || !moderatorEmails.has(req.user.email.toLowerCase())) {
    return next(apiError("Apenas moderadores autorizados podem usar esta área.", 403));
  }
  return next();
}

async function requireConversationMember(conversationId, userId) {
  const result = await admin.from("conversation_members")
    .select("conversation_id")
    .eq("conversation_id", conversationId)
    .eq("user_id", userId)
    .maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) throw apiError("Você não participa desta conversa.", 403);
}

async function signedUrl(bucket, path) {
  if (!path) return null;
  const { data, error } = await admin.storage.from(bucket).createSignedUrl(path, 300);
  if (error) throw error;
  return data.signedUrl;
}

function detectedImageType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6))) return "image/gif";
  return null;
}

async function uploadImage(file, bucket, path) {
  if (!file) return null;
  const actualType = detectedImageType(file.buffer);
  if (!actualType || actualType !== file.mimetype) {
    throw apiError("O arquivo não é uma imagem JPG, PNG, WebP ou GIF válida.");
  }
  const extension = ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" })[actualType];
  const objectPath = `${path}/${randomUUID()}.${extension}`;
  const { error } = await admin.storage.from(bucket).upload(objectPath, file.buffer, {
    contentType: actualType,
    upsert: false,
  });
  if (error) throw error;
  return objectPath;
}

app.use("/api", (req, res, next) => {
  if (req.method === "GET" && req.path === "/access") return next();
  return requireUser(req, res, next);
});

app.get("/api/access", async (req, res) => {
  try {
    const ip = trustedClientIp(req);
    const ban = await checkIpBan(ip);
    return res.json({ allowed: !ban, banned: Boolean(ban) });
  } catch (error) {
    return sendError(res, error);
  }
});

app.post("/api/consent", async (req, res) => {
  try {
    if (req.body?.accepted !== true) throw apiError("É necessário confirmar o aviso de registro de IP.");
    const { error: consentError } = await admin.from("ip_consents").upsert({
      user_id: req.user.id,
      policy_version: "2026-11-v1",
      accepted_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
    if (consentError) throw consentError;
    const { error: recordError } = await admin.from("user_ip_addresses").upsert({
      user_id: req.user.id,
      ip_address: req.clientIp,
      last_seen_at: new Date().toISOString(),
    }, { onConflict: "user_id,ip_address" });
    if (recordError) throw recordError;
    return res.json({ accepted: true });
  } catch (error) {
    return sendError(res, error);
  }
});

app.get("/api/bootstrap", async (req, res) => {
  try {
    const userId = req.user.id;
    const [profileResult, contactResult, requestResult, membershipResult] = await Promise.all([
      admin.from("profiles").select("id,display_name,discriminator,avatar_path,bio,profile_link").eq("id", userId).single(),
      admin.from("user_contacts").select("id,display_name,email,created_at").eq("owner_id", userId).order("created_at", { ascending: false }),
      admin.from("friend_requests").select("id,sender_id,recipient_id,status,created_at")
        .or(`sender_id.eq.${userId},recipient_id.eq.${userId}`).order("created_at", { ascending: false }),
      admin.from("conversation_members").select("conversation_id").eq("user_id", userId),
    ]);
    const profile = requireData(profileResult);
    const contacts = requireData(contactResult);
    const requests = requireData(requestResult);
    const memberships = requireData(membershipResult);
    const conversationIds = memberships.map((entry) => entry.conversation_id);
    const [conversationResult, messageResult] = await Promise.all([
      conversationIds.length
        ? admin.from("conversations").select("id,type,title,updated_at").in("id", conversationIds).order("updated_at", { ascending: false })
        : Promise.resolve({ data: [], error: null }),
      conversationIds.length
        ? admin.from("messages").select("id,conversation_id,body,attachment_path,sender_id,created_at")
          .in("conversation_id", conversationIds).order("created_at", { ascending: false }).limit(1000)
        : Promise.resolve({ data: [], error: null }),
    ]);
    const conversations = requireData(conversationResult);
    const messages = requireData(messageResult);
    const memberResult = await (conversationIds.length
      ? admin.from("conversation_members").select("conversation_id,user_id").in("conversation_id", conversationIds)
      : Promise.resolve({ data: [], error: null }));
    const members = requireData(memberResult);
    const profileIds = new Set([userId]);
    for (const request of requests) {
      profileIds.add(request.sender_id);
      profileIds.add(request.recipient_id);
    }
    for (const member of members) profileIds.add(member.user_id);
    profileIds.delete(userId);
    const relatedProfilesResult = profileIds.size
      ? await admin.from("profiles").select("id,display_name,discriminator,avatar_path,bio,profile_link").in("id", [...profileIds])
      : { data: [], error: null };
    const profiles = requireData(relatedProfilesResult);
    const profilesById = new Map([[profile.id, profile], ...profiles.map((entry) => [entry.id, entry])]);
    const messagesByConversation = new Map();
    for (const message of messages.reverse()) {
      const list = messagesByConversation.get(message.conversation_id) || [];
      list.push(message);
      messagesByConversation.set(message.conversation_id, list);
    }

    const friendRequests = await Promise.all(requests.map(async (request) => ({
      ...request,
      sender: profilesById.get(request.sender_id) || null,
      recipient: profilesById.get(request.recipient_id) || null,
    })));
    const conversationsWithData = await Promise.all(conversations.map(async (conversation) => {
      const conversationMembers = members.filter((member) => member.conversation_id === conversation.id)
        .map((member) => profilesById.get(member.user_id)).filter(Boolean);
      const conversationMessages = await Promise.all((messagesByConversation.get(conversation.id) || []).map(async (message) => ({
        ...message,
        photo_url: await signedUrl(photoBucket, message.attachment_path),
      })));
      const lastMessage = conversationMessages[conversationMessages.length - 1];
      return {
        ...conversation,
        members: conversationMembers.map((member) => ({ ...member, avatar_url: null })),
        messages: conversationMessages,
        last_message: lastMessage?.body || (lastMessage?.attachment_path ? "📷 Foto" : ""),
      };
    }));

    const requestedProfileIds = new Set([
      ...friendRequests.flatMap((request) => [request.sender_id, request.recipient_id]),
      ...members.map((member) => member.user_id),
    ]);
    const profilesWithUrls = await Promise.all([...requestedProfileIds].map(async (id) => {
      const item = profilesById.get(id);
      if (!item) return null;
      return { ...item, avatar_url: await signedUrl(avatarBucket, item.avatar_path) };
    }));
    const profilesByIdWithUrls = new Map(profilesWithUrls.filter(Boolean).map((item) => [item.id, item]));
    for (const request of friendRequests) {
      request.sender = profilesByIdWithUrls.get(request.sender_id) || null;
      request.recipient = profilesByIdWithUrls.get(request.recipient_id) || null;
    }
    for (const conversation of conversationsWithData) {
      conversation.members = conversation.members.map((member) => profilesByIdWithUrls.get(member.id) || member);
    }
    return res.json({
      profile: { ...profile, avatar_url: await signedUrl(avatarBucket, profile.avatar_path) },
      contacts,
      friend_requests: friendRequests,
      conversations: conversationsWithData,
      moderator: moderatorEmails.has(req.user.email?.toLowerCase()),
    });
  } catch (error) {
    return sendError(res, error);
  }
});

app.post("/api/friend-requests", async (req, res) => {
  try {
    const handle = typeof req.body?.handle === "string" ? req.body.handle.trim() : "";
    const match = handle.match(/^(.{1,60})#(\d{6})$/u);
    if (!match || !match[1].trim()) {
      throw apiError("Digite o apelido completo no formato apelido#123456.");
    }
    const result = await admin.rpc("request_friend_by_nickname", {
      p_owner_id: req.user.id,
      p_nickname: match[1].trim(),
      p_discriminator: Number(match[2]),
    });
    const status = requireData(result);
    if (!["requested", "already_requested", "already_friends", "incoming_pending", "self", "not_found"].includes(status)) {
      throw new Error("Unexpected nickname friend request result.");
    }
    return res.json({ status });
  } catch (error) {
    return sendError(res, error);
  }
});

app.post("/api/friend-requests/:id/respond", async (req, res) => {
  try {
    if (!isUuid(req.params.id)) throw apiError("Pedido de amizade inválido.");
    const { accept } = req.body || {};
    if (typeof accept !== "boolean") throw apiError("Escolha aceitar ou recusar o pedido.");
    const request = requireData(await admin.from("friend_requests").select("id,sender_id,recipient_id,status")
      .eq("id", req.params.id).eq("recipient_id", req.user.id).eq("status", "pending").maybeSingle());
    if (!request) throw apiError("Esse pedido não está mais disponível.", 404);
    requireData(await admin.from("friend_requests").update({ status: accept ? "accepted" : "declined" })
      .eq("id", request.id).eq("recipient_id", req.user.id));
    if (accept) {
      requireData(await admin.from("friend_requests").update({ status: "accepted" })
        .eq("sender_id", req.user.id).eq("recipient_id", request.sender_id).eq("status", "pending"));
    }
    return res.json({ ok: true });
  } catch (error) {
    return sendError(res, error);
  }
});

app.post("/api/conversations/direct", async (req, res) => {
  try {
    const otherId = req.body?.user_id;
    if (!isUuid(otherId) || otherId === req.user.id) throw apiError("Escolha um amigo válido.");
    const requestResult = await admin.from("friend_requests").select("id").eq("status", "accepted")
      .or(`and(sender_id.eq.${req.user.id},recipient_id.eq.${otherId}),and(sender_id.eq.${otherId},recipient_id.eq.${req.user.id})`)
      .maybeSingle();
    if (requestResult.error) throw requestResult.error;
    if (!requestResult.data) throw apiError("Só é possível conversar com amigos que aceitaram seu convite.", 403);
    const directKey = [req.user.id, otherId].sort().join(":");
    const conversation = requireData(await admin.from("conversations")
      .upsert({ type: "direct", direct_key: directKey, created_by: req.user.id }, { onConflict: "direct_key" })
      .select("id").single());
    requireData(await admin.from("conversation_members").upsert(
      [{ conversation_id: conversation.id, user_id: req.user.id }, { conversation_id: conversation.id, user_id: otherId }],
      { onConflict: "conversation_id,user_id", ignoreDuplicates: true },
    ));
    return res.json({ id: conversation.id });
  } catch (error) {
    return sendError(res, error);
  }
});

app.post("/api/conversations/groups", async (req, res) => {
  try {
    const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    const memberIds = Array.isArray(req.body?.member_ids) ? [...new Set(req.body.member_ids)] : [];
    if (!title || title.length > 80 || memberIds.length > 99 || memberIds.some((id) => !isUuid(id))) {
      throw apiError("Informe um nome e escolha no máximo 99 amigos.");
    }
    const ids = memberIds.filter((id) => id !== req.user.id);
    if (ids.length) {
      const requests = requireData(await admin.from("friend_requests").select("sender_id,recipient_id")
        .eq("status", "accepted").or(`sender_id.eq.${req.user.id},recipient_id.eq.${req.user.id}`));
      const accepted = new Set(requests.flatMap((request) => [
        request.sender_id === req.user.id ? request.recipient_id : null,
        request.recipient_id === req.user.id ? request.sender_id : null,
      ]).filter(Boolean));
      if (ids.some((id) => !accepted.has(id))) throw apiError("Todos os participantes precisam ser seus amigos confirmados.", 403);
    }
    const conversation = requireData(await admin.from("conversations")
      .insert({ type: "group", title, created_by: req.user.id }).select("id").single());
    requireData(await admin.from("conversation_members").insert(
      [req.user.id, ...ids].map((user_id) => ({ conversation_id: conversation.id, user_id })),
    ));
    return res.status(201).json({ id: conversation.id });
  } catch (error) {
    return sendError(res, error);
  }
});

app.post("/api/conversations/:id/messages", upload.single("photo"), async (req, res) => {
  let uploadedPath;
  try {
    if (!isUuid(req.params.id)) throw apiError("Conversa inválida.");
    await requireConversationMember(req.params.id, req.user.id);
    const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
    if (body.length > 4000) throw apiError("A mensagem deve ter no máximo 4.000 caracteres.");
    if (!body && !req.file) throw apiError("Escreva uma mensagem ou escolha uma foto.");
    if (req.file) uploadedPath = await uploadImage(req.file, photoBucket, `${req.user.id}/${req.params.id}`);
    const message = requireData(await admin.from("messages").insert({
      conversation_id: req.params.id,
      sender_id: req.user.id,
      body,
      attachment_path: uploadedPath,
    }).select("id,conversation_id,body,attachment_path,sender_id,created_at").single());
    return res.status(201).json({
      ...message,
      photo_url: await signedUrl(photoBucket, message.attachment_path),
    });
  } catch (error) {
    if (uploadedPath) {
      const { error: removeError } = await admin.storage.from(photoBucket).remove([uploadedPath]);
      if (removeError) console.error("Failed to clean up an unlinked message photo:", removeError);
    }
    return sendError(res, error);
  }
});

app.put("/api/profile", async (req, res) => {
  try {
    const displayName = typeof req.body?.display_name === "string" ? req.body.display_name.trim() : "";
    if (!displayName || displayName.length > 60) throw apiError("O nome deve ter entre 1 e 60 caracteres.");
    const bio = typeof req.body?.bio === "string" ? req.body.bio.trim() : "";
    const profileLink = typeof req.body?.profile_link === "string" ? req.body.profile_link.trim() : "";
    if (bio.length > 160) throw apiError("A biografia deve ter no máximo 160 caracteres.");
    if (profileLink.length > 200) throw apiError("O link deve ter no máximo 200 caracteres.");
    if (profileLink) {
      let parsedLink;
      try {
        parsedLink = new URL(profileLink);
      } catch {
        throw apiError("Informe um link válido começando com https://.");
      }
      if (!["http:", "https:"].includes(parsedLink.protocol)) {
        throw apiError("O link deve começar com http:// ou https://.");
      }
    }
    const profile = requireData(await admin.from("profiles").update({
      display_name: displayName,
      bio,
      profile_link: profileLink,
    }).eq("id", req.user.id).select("id,display_name,discriminator,avatar_path,bio,profile_link").single());
    return res.json({ ...profile, avatar_url: await signedUrl(avatarBucket, profile.avatar_path) });
  } catch (error) {
    return sendError(res, error);
  }
});

app.post("/api/profile/photo", upload.single("photo"), async (req, res) => {
  let uploadedPath;
  try {
    if (!req.file || req.file.size > 5 * 1024 * 1024) throw apiError("Escolha uma foto de até 5 MB.");
    const oldProfile = requireData(await admin.from("profiles").select("avatar_path").eq("id", req.user.id).single());
    uploadedPath = await uploadImage(req.file, avatarBucket, `${req.user.id}/profile`);
    const profile = requireData(await admin.from("profiles").update({ avatar_path: uploadedPath })
      .eq("id", req.user.id).select("id,display_name,discriminator,avatar_path,bio,profile_link").single());
    if (oldProfile.avatar_path) {
      const { error } = await admin.storage.from(avatarBucket).remove([oldProfile.avatar_path]);
      if (error) console.error("Failed to remove replaced profile photo:", error);
    }
    return res.json({ ...profile, avatar_url: await signedUrl(avatarBucket, profile.avatar_path) });
  } catch (error) {
    if (uploadedPath) {
      const { error: removeError } = await admin.storage.from(avatarBucket).remove([uploadedPath]);
      if (removeError) console.error("Failed to clean up an unlinked profile photo:", removeError);
    }
    return sendError(res, error);
  }
});

app.get("/api/admin/moderation", requireModerator, async (_req, res) => {
  try {
    const [ips, profiles, bans, activity] = await Promise.all([
      admin.from("user_ip_addresses").select("user_id,ip_address,first_seen_at,last_seen_at").order("last_seen_at", { ascending: false }).limit(1000),
      admin.from("profiles").select("id,display_name,avatar_path").limit(1000),
      admin.from("ip_bans").select("id,ip_address,reason,banned_by,created_at").order("created_at", { ascending: false }),
      admin.rpc("admin_message_activity"),
    ]);
    const ipRecords = requireData(ips);
    const profileList = requireData(profiles);
    const banList = requireData(bans);
    const messageActivity = requireData(activity);
    const profilesById = new Map(profileList.map((profile) => [profile.id, profile]));
    const activityById = new Map(messageActivity.map((item) => [item.user_id, item]));
    const uniqueProfiles = new Map(ipRecords.map((record) => [record.user_id, profilesById.get(record.user_id)]).filter((entry) => entry[1]));
    const profileUrls = new Map(await Promise.all([...uniqueProfiles].map(async ([id, profile]) => [
      id,
      await signedUrl(avatarBucket, profile.avatar_path),
    ])));
    return res.json({
      addresses: ipRecords.map((record) => {
        const userProfile = profilesById.get(record.user_id);
        const activity = activityById.get(record.user_id);
        return {
          ...record,
          display_name: userProfile?.display_name || "Pessoa usuária",
          avatar_url: profileUrls.get(record.user_id) || null,
          message_count: activity?.message_count || 0,
          last_message_at: activity?.last_message_at || null,
        };
      }),
      bans: banList,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

app.post("/api/admin/ip-bans", requireModerator, async (req, res) => {
  try {
    const ip = typeof req.body?.ip_address === "string" ? req.body.ip_address.trim() : "";
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!isIP(ip)) throw apiError("Informe um IPv4 ou IPv6 válido.");
    if (!reason || reason.length > 300) throw apiError("Descreva o motivo do bloqueio (até 300 caracteres).");
    if (ip === req.clientIp) throw apiError("Não é possível bloquear o IP desta sessão de moderação.");
    const ban = requireData(await admin.from("ip_bans").insert({
      ip_address: ip,
      reason,
      banned_by: req.user.id,
    }).select("id,ip_address,reason,created_at").single());
    return res.status(201).json(ban);
  } catch (error) {
    return sendError(res, error);
  }
});

app.delete("/api/admin/ip-bans/:id", requireModerator, async (req, res) => {
  try {
    if (!isUuid(req.params.id)) throw apiError("Bloqueio inválido.");
    const { error } = await admin.from("ip_bans").delete().eq("id", req.params.id);
    if (error) throw error;
    return res.status(204).end();
  } catch (error) {
    return sendError(res, error);
  }
});

app.use("/api", (_req, res) => res.status(404).json({ error: "Endpoint não encontrado." }));
app.use((error, _req, res, _next) => sendError(res, error));

const distPath = resolve(root, "dist");
app.use(express.static(distPath, { index: false, maxAge: "1h" }));
app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api/")) return next();
  return res.sendFile(resolve(distPath, "index.html"));
});

createServer(app).listen(port, "0.0.0.0", () => {
  console.log(`laço server listening on ${port}`);
});
