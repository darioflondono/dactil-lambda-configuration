import { TABLES, getItem, putItem, updateItem, deleteItem, scanAll } from '../db.js';
import { badRequest, conflict, notFound, unauthorized } from '../errors.js';
import { hashPassword, verifyPassword } from '../auth.js';
import { sendWelcomeEmail } from '../email.js';
import { isEmail, nowIso, oneOf, str } from '../util.js';

const T = () => TABLES.users;
const ROLES = ['implementador', 'administrador', 'invitado'];

/** DTO público: nunca expone hashes de contraseña. */
function toDto(item) {
  if (!item) return null;
  return {
    identification: item.identification,
    name: item.name,
    email: item.email,
    role: item.role,
    company_id: item.company_id,
    is_active: item.is_active !== false,
    must_change_password: !!item.must_change_password,
    created_at: item.created_at,
    updated_at: item.updated_at
  };
}

// GET /users/   -> [ { identification, name, email, role, company_id } ]
export async function list() {
  const items = await scanAll(T());
  return items.map(toDto).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

// GET /users/{identification}   (para la lupa del portal)
export async function get({ params }) {
  const item = await getItem(T(), { identification: params.id });
  if (!item) throw notFound('Usuario no encontrado');
  return toDto(item);
}

// POST /users/   <- { identification, name, email, password, role, company_id, is_active }
//   -> hashea password, marca must_change_password, envía correo de bienvenida
export async function create({ body }) {
  const identification = str(body.identification, 'identification');
  const name = str(body.name, 'name');
  const email = str(body.email, 'email').toLowerCase();
  if (!isEmail(email)) throw badRequest('El correo no es válido');
  const tempPassword = str(body.password, 'password');
  const role = oneOf(body.role ?? 'invitado', ROLES, 'role');
  const company_id = str(body.company_id, 'company_id');
  const is_active = body.is_active !== false;

  // Unicidad: identificación y correo
  if (await getItem(T(), { identification })) throw conflict('Ya existe un usuario con esa identificación');
  if ((await findByEmail(email)).length > 0) throw conflict('Ya existe un usuario con ese correo');

  const ts = nowIso();
  const item = {
    identification,
    name,
    email,
    password_hash: await hashPassword(tempPassword),
    role,
    company_id,
    is_active,
    must_change_password: true,
    created_at: ts,
    updated_at: ts
  };
  await putItem(T(), item);

  // El envío del correo no debe tumbar el alta: sendWelcomeEmail nunca lanza.
  const emailResult = await sendWelcomeEmail({ to: email, name, tempPassword });
  console.log(
    `[users.create] usuario=${identification} email=${email} ` +
      `correo_enviado=${emailResult.sent}` +
      (emailResult.messageId ? ` messageId=${emailResult.messageId}` : '') +
      (emailResult.reason ? ` motivo=${emailResult.reason}` : '') +
      (emailResult.error ? ` error="${emailResult.error}"` : '')
  );

  return {
    ...toDto(item),
    email_sent: emailResult.sent,
    email_message_id: emailResult.messageId ?? null,
    activation_link: emailResult.link
  };
}

// PUT /users/{identification}   <- { name?, email?, role?, company_id?, is_active? }   (SIN password)
export async function update({ params, body }) {
  const current = await getItem(T(), { identification: params.id });
  if (!current) throw notFound('Usuario no encontrado');

  const patch = { updated_at: nowIso() };
  if (body.name !== undefined) patch.name = str(body.name, 'name');
  if (body.role !== undefined) patch.role = oneOf(body.role, ROLES, 'role');
  if (body.company_id !== undefined) patch.company_id = str(body.company_id, 'company_id');
  if (body.is_active !== undefined) patch.is_active = body.is_active !== false;
  if (body.email !== undefined) {
    const email = str(body.email, 'email').toLowerCase();
    if (!isEmail(email)) throw badRequest('El correo no es válido');
    if (email !== current.email) {
      const clash = (await findByEmail(email)).filter((u) => u.identification !== params.id);
      if (clash.length > 0) throw conflict('Ya existe un usuario con ese correo');
      patch.email = email;
    }
  }
  if (body.password !== undefined) throw badRequest('La contraseña no se edita aquí (usa /auth/set-password)');

  const updated = await updateItem(T(), { identification: params.id }, patch);
  return toDto(updated);
}

// DELETE /users/{identification}
export async function remove({ params }) {
  try {
    await deleteItem(T(), { identification: params.id });
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') throw notFound('Usuario no encontrado');
    throw e;
  }
  return null;
}

// POST /auth/set-password   <- { email, temp_password, new_password }
export async function setPassword({ body }) {
  const email = str(body.email, 'email').toLowerCase();
  const tempPassword = str(body.temp_password, 'temp_password');
  const newPassword = str(body.new_password, 'new_password');
  if (newPassword.length < 8) throw badRequest('La nueva contraseña debe tener al menos 8 caracteres');

  const matches = await findByEmail(email);
  const user = matches[0];
  if (!user) throw unauthorized('Correo o contraseña temporal incorrectos');
  if (user.is_active === false) throw unauthorized('El usuario está inactivo');

  const okTemp = await verifyPassword(tempPassword, user.password_hash);
  if (!okTemp) throw unauthorized('Correo o contraseña temporal incorrectos');

  await updateItem(
    T(),
    { identification: user.identification },
    {
      password_hash: await hashPassword(newPassword),
      must_change_password: false,
      updated_at: nowIso()
    }
  );
  return { email, updated: true };
}

// ─────────────────────────────────────────── helpers
/** Busca por correo con Scan+Filter (tabla de usuarios pequeña).
 *  Para escala, crea un GSI 'by-email' y sustituye por Query. */
async function findByEmail(email) {
  return scanAll(T(), {
    filter: { expression: '#e = :e', names: { '#e': 'email' }, values: { ':e': email } }
  });
}
