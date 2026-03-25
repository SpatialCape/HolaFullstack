import { useState, useEffect, useCallback, useRef } from 'react'
import './App.css'

const API = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '')
const POOL_ID = import.meta.env.VITE_COGNITO_USER_POOL_ID || ''
const CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID || ''
const REGION = POOL_ID.split('_')[0] || 'us-east-1'
const COGNITO_URL = `https://cognito-idp.${REGION}.amazonaws.com/`

/* ------------------------------------------------------------------ */
/*  Cognito helpers (API directa, sin SDK extra)                      */
/* ------------------------------------------------------------------ */
async function cognitoFetch(action, body) {
  const res = await fetch(COGNITO_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AWSCognitoIdentityProviderService.${action}`,
    },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (data.__type) throw new Error(data.message || data.__type)
  return data
}

function signIn(email, password) {
  return cognitoFetch('InitiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: CLIENT_ID,
    AuthParameters: { USERNAME: email, PASSWORD: password },
  })
}

function respondNewPassword(session, email, newPassword) {
  return cognitoFetch('RespondToAuthChallenge', {
    ChallengeName: 'NEW_PASSWORD_REQUIRED',
    ClientId: CLIENT_ID,
    Session: session,
    ChallengeResponses: { USERNAME: email, NEW_PASSWORD: newPassword },
  })
}

function refreshSession(refreshToken) {
  return cognitoFetch('InitiateAuth', {
    AuthFlow: 'REFRESH_TOKEN_AUTH',
    ClientId: CLIENT_ID,
    AuthParameters: { REFRESH_TOKEN: refreshToken },
  })
}

/* ------------------------------------------------------------------ */
/*  Token helpers                                                      */
/* ------------------------------------------------------------------ */
function saveTokens(result) {
  const auth = result.AuthenticationResult
  if (!auth) return null
  localStorage.setItem('idToken', auth.IdToken)
  localStorage.setItem('accessToken', auth.AccessToken)
  if (auth.RefreshToken) localStorage.setItem('refreshToken', auth.RefreshToken)
  return auth.IdToken
}

function clearTokens() {
  localStorage.removeItem('idToken')
  localStorage.removeItem('accessToken')
  localStorage.removeItem('refreshToken')
}

function isTokenExpired(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]))
    return payload.exp * 1000 < Date.now()
  } catch {
    return true
  }
}

/* ------------------------------------------------------------------ */
/*  Offline helpers (localStorage queue)                               */
/* ------------------------------------------------------------------ */
function getPendingOps() {
  try { return JSON.parse(localStorage.getItem('pendingOps') || '[]') }
  catch { return [] }
}

function savePendingOps(ops) {
  localStorage.setItem('pendingOps', JSON.stringify(ops))
}

function addPendingOp(op) {
  const ops = getPendingOps()
  ops.push(op)
  savePendingOps(ops)
}

function getCachedTasks() {
  try { return JSON.parse(localStorage.getItem('cachedTasks') || '[]') }
  catch { return [] }
}

function saveCachedTasks(tasks) {
  localStorage.setItem('cachedTasks', JSON.stringify(tasks))
}

function isNetworkError(err) {
  if (!navigator.onLine) return true
  const msg = String(err?.message || '').toLowerCase()
  return err?.name === 'TypeError' || msg.includes('fetch') || msg.includes('network') || msg.includes('load failed')
}

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */
function App() {
  const [token, setToken] = useState(null)
  const [showLogin, setShowLogin] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [session, setSession] = useState(null)
  const [needNewPwd, setNeedNewPwd] = useState(false)
  const [authError, setAuthError] = useState(null)
  const [authLoading, setAuthLoading] = useState(false)

  const [tasks, setTasks] = useState(() => getCachedTasks())
  const [loading, setLoading] = useState(() => getCachedTasks().length === 0)
  const [error, setError] = useState(null)
  const [newTitle, setNewTitle] = useState('')
  const [adding, setAdding] = useState(false)
  const [editId, setEditId] = useState(null)
  const [editTitle, setEditTitle] = useState('')

  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const [showReconnect, setShowReconnect] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const syncLock = useRef(false)

  const isAdmin = !!token

  // Reconectar: sincronizar ops pendientes y refrescar
  async function reconnect() {
    setIsOnline(true)
    setShowReconnect(true)
    setError(null)
    await syncPendingOps()
    setTimeout(() => setShowReconnect(false), 4000)
  }

  // Sincronizar operaciones pendientes (con lock para evitar duplicados)
  async function syncPendingOps() {
    if (syncLock.current) return
    syncLock.current = true
    const ops = getPendingOps()
    if (ops.length === 0) { syncLock.current = false; await fetchTasks(); return }
    savePendingOps([]) // limpiar cola ANTES de procesar para evitar duplicados
    setSyncing(true)
    for (const op of ops) {
      try {
        const h = await authHeaders()
        if (!h) break
        if (op.type === 'add') {
          await fetch(`${API}/tasks`, { method: 'POST', headers: h, body: JSON.stringify({ title: op.title }) })
        } else if (op.type === 'toggle') {
          await fetch(`${API}/tasks/${op.id}`, { method: 'PUT', headers: h, body: JSON.stringify({ completed: op.completed }) })
        } else if (op.type === 'edit') {
          await fetch(`${API}/tasks/${op.id}`, { method: 'PUT', headers: h, body: JSON.stringify({ title: op.title }) })
        } else if (op.type === 'delete') {
          await fetch(`${API}/tasks/${op.id}`, { method: 'DELETE', headers: h })
        }
      } catch {
        // si falla una op individual, continuar con las demas
      }
    }
    setSyncing(false)
    syncLock.current = false
    await fetchTasks()
  }

  // Detectar conexion / desconexion + polling
  useEffect(() => {
    function handleOffline() { setIsOnline(false) }
    function handleOnline() { reconnect() }
    window.addEventListener('offline', handleOffline)
    window.addEventListener('online', handleOnline)

    // Polling: si estamos offline, intentar reconectar cada 5s
    let interval
    if (!isOnline) {
      interval = setInterval(async () => {
        try {
          const res = await fetch(`${API}/tasks`)
          if (res.ok) { clearInterval(interval); reconnect() }
        } catch { /* sigue offline */ }
      }, 5000)
    }

    return () => {
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener('online', handleOnline)
      if (interval) clearInterval(interval)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline, token])

  // Al cargar la pagina: si hay ops pendientes y hay red, sincronizar
  useEffect(() => {
    if (token && getPendingOps().length > 0) {
      syncPendingOps()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  // Restaurar sesion guardada
  useEffect(() => {
    const stored = localStorage.getItem('idToken')
    if (stored && !isTokenExpired(stored)) {
      setToken(stored)
    } else if (stored) {
      const refresh = localStorage.getItem('refreshToken')
      if (refresh) {
        refreshSession(refresh)
          .then((r) => { const t = saveTokens(r); t ? setToken(t) : clearTokens() })
          .catch(() => clearTokens())
      } else {
        clearTokens()
      }
    }
  }, [])

  // Cargar tareas (publico) — con cache offline
  const fetchTasks = useCallback(async () => {
    if (!API) { setError('Configura VITE_API_URL'); setLoading(false); return }
    try {
      const res = await fetch(`${API}/tasks`)
      if (!res.ok) throw new Error(res.statusText)
      const data = await res.json()
      setTasks(data)
      saveCachedTasks(data)
      setError(null)
    } catch (err) {
      const cached = getCachedTasks()
      if (isNetworkError(err)) {
        // Sin red: mostrar cache y activar banner offline
        setIsOnline(false)
        setTasks(cached.length > 0 ? cached : [])
        setError(null)
      } else if (cached.length > 0) {
        setTasks(cached)
      } else {
        setError(err.message)
        setTasks([])
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchTasks() }, [fetchTasks])

  // Headers con token (refresca si expiro)
  async function authHeaders() {
    let t = token
    if (!t) return null
    if (isTokenExpired(t)) {
      // Si ya sabemos que no hay red, devolver token existente sin intentar refrescar
      if (!isOnline) return { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }
      const refresh = localStorage.getItem('refreshToken')
      if (refresh) {
        try {
          const r = await refreshSession(refresh)
          t = saveTokens(r)
          setToken(t)
        } catch (err) {
          if (isNetworkError(err)) {
            setIsOnline(false)
            return { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }
          }
          clearTokens(); setToken(null); return null
        }
      } else {
        clearTokens(); setToken(null); return null
      }
    }
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }
  }

  // --- Auth ---
  function resetLogin() {
    setEmail(''); setPassword(''); setNewPwd('')
    setSession(null); setNeedNewPwd(false); setAuthError(null)
  }

  async function handleLogin(e) {
    e.preventDefault()
    setAuthError(null); setAuthLoading(true)
    try {
      const result = await signIn(email, password)
      if (result.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
        setSession(result.Session)
        setNeedNewPwd(true)
      } else {
        const t = saveTokens(result)
        setToken(t); setShowLogin(false); resetLogin()
      }
    } catch (err) {
      setAuthError(err.message)
    } finally {
      setAuthLoading(false)
    }
  }

  async function handleNewPassword(e) {
    e.preventDefault()
    setAuthError(null); setAuthLoading(true)
    try {
      const result = await respondNewPassword(session, email, newPwd)
      const t = saveTokens(result)
      setToken(t); setShowLogin(false); resetLogin()
    } catch (err) {
      setAuthError(err.message)
    } finally {
      setAuthLoading(false)
    }
  }

  function logout() { clearTokens(); setToken(null) }

  // --- Helpers offline ---
  function goOffline() {
    setIsOnline(false)
    setError(null)
  }

  function queueAdd(title) {
    const tempTask = { id: 'temp-' + Date.now(), title, completed: false, createdAt: new Date().toISOString(), _pending: true }
    setTasks(prev => { const next = [...prev, tempTask]; saveCachedTasks(next); return next })
    addPendingOp({ type: 'add', title })
    setNewTitle('')
    goOffline()
  }

  function queueToggle(task) {
    setTasks(prev => {
      const next = prev.map(t => t.id === task.id ? { ...t, completed: !t.completed } : t)
      saveCachedTasks(next)
      return next
    })
    addPendingOp({ type: 'toggle', id: task.id, completed: !task.completed })
    goOffline()
  }

  function queueEdit(id, title) {
    setTasks(prev => {
      const next = prev.map(t => t.id === id ? { ...t, title } : t)
      saveCachedTasks(next)
      return next
    })
    addPendingOp({ type: 'edit', id, title })
    setEditId(null); setEditTitle('')
    goOffline()
  }

  function queueDelete(id) {
    setTasks(prev => {
      const next = prev.filter(t => t.id !== id)
      saveCachedTasks(next)
      return next
    })
    addPendingOp({ type: 'delete', id })
    goOffline()
  }

  // --- CRUD (protegido, con soporte offline) ---
  async function addTask(e) {
    e.preventDefault()
    const title = newTitle.trim()
    if (!title || adding) return
    if (!isOnline) { queueAdd(title); return }
    const h = await authHeaders()
    if (!h) return
    setAdding(true)
    try {
      const res = await fetch(`${API}/tasks`, { method: 'POST', headers: h, body: JSON.stringify({ title }) })
      if (!res.ok) throw new Error(res.statusText)
      setNewTitle(''); await fetchTasks()
    } catch (err) {
      queueAdd(title)
    } finally { setAdding(false) }
  }

  async function toggleCompleted(task) {
    if (!isOnline) { queueToggle(task); return }
    const h = await authHeaders()
    if (!h) return
    try {
      const res = await fetch(`${API}/tasks/${task.id}`, {
        method: 'PUT', headers: h, body: JSON.stringify({ completed: !task.completed }),
      })
      if (!res.ok) throw new Error(res.statusText)
      await fetchTasks()
    } catch (err) {
      queueToggle(task)
    }
  }

  async function saveEdit(id) {
    const title = editTitle.trim()
    if (!title) return
    if (!isOnline) { queueEdit(id, title); return }
    const h = await authHeaders()
    if (!h) return
    try {
      const res = await fetch(`${API}/tasks/${id}`, {
        method: 'PUT', headers: h, body: JSON.stringify({ title }),
      })
      if (!res.ok) throw new Error(res.statusText)
      setEditId(null); setEditTitle(''); await fetchTasks()
    } catch (err) {
      queueEdit(id, title)
    }
  }

  async function deleteTask(id) {
    if (!window.confirm('¿Eliminar esta tarea?')) return
    if (!isOnline) { queueDelete(id); return }
    const h = await authHeaders()
    if (!h) return
    try {
      const res = await fetch(`${API}/tasks/${id}`, { method: 'DELETE', headers: h })
      if (!res.ok) throw new Error(res.statusText)
      await fetchTasks()
    } catch (err) {
      queueDelete(id)
    }
  }

  // --- Render ---
  return (
    <div className="app">
      {/* Banners de conexion */}
      {!isOnline && (
        <div className="offline-banner">
          Sin conexion — Estas en modo desconectado. Los cambios se guardaran al reconectar.
        </div>
      )}
      {showReconnect && (
        <div className="reconnect-banner">
          {syncing ? 'Conexion reestablecida, guardando cambios...' : 'Conexion reestablecida. Cambios guardados.'}
        </div>
      )}

      <header className="header">
        <h1>Tareas</h1>
        {isAdmin ? (
          <button className="btn btn-outline" onClick={logout}>Cerrar sesion</button>
        ) : (
          <button className="btn btn-outline" onClick={() => setShowLogin(true)}>Administrar</button>
        )}
      </header>

      {/* Login modal */}
      {showLogin && !isAdmin && (
        <div className="overlay" onClick={() => { setShowLogin(false); resetLogin() }}>
          <div className="panel" onClick={(e) => e.stopPropagation()}>
            <h2>{needNewPwd ? 'Nueva contraseña' : 'Iniciar sesion'}</h2>
            {!needNewPwd ? (
              <form onSubmit={handleLogin}>
                <input type="email" placeholder="Email" value={email}
                  onChange={(e) => setEmail(e.target.value)} required autoFocus />
                <input type="password" placeholder="Contraseña" value={password}
                  onChange={(e) => setPassword(e.target.value)} required />
                {authError && <p className="auth-error">{authError}</p>}
                <button className="btn btn-primary full" type="submit" disabled={authLoading}>
                  {authLoading ? 'Entrando...' : 'Entrar'}
                </button>
              </form>
            ) : (
              <form onSubmit={handleNewPassword}>
                <p className="hint">Establece tu nueva contraseña permanente.</p>
                <input type="password" placeholder="Nueva contraseña" value={newPwd}
                  onChange={(e) => setNewPwd(e.target.value)} required autoFocus />
                {authError && <p className="auth-error">{authError}</p>}
                <button className="btn btn-primary full" type="submit" disabled={authLoading}>
                  {authLoading ? 'Guardando...' : 'Guardar contraseña'}
                </button>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Formulario para agregar (solo admin) */}
      {isAdmin && (
        <form className="add-form" onSubmit={addTask}>
          <input type="text" placeholder="Nueva tarea..." value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)} disabled={adding} />
          <button className="btn btn-primary" type="submit" disabled={!newTitle.trim() || adding}>
            {adding ? 'Añadiendo...' : 'Añadir'}
          </button>
        </form>
      )}

      {error && <p className="error-msg">{error}</p>}

      {loading ? (
        <p className="status-msg">Cargando tareas...</p>
      ) : tasks.length === 0 ? (
        <p className="status-msg">No hay tareas{isAdmin ? '. Añade una arriba.' : '.'}</p>
      ) : (
        <ul className="task-list">
          {tasks.map((task) => (
            <li key={task.id} className={`task${task.completed ? ' done' : ''}${task._pending ? ' pending' : ''}`}>
              {isAdmin && (
                <input type="checkbox" checked={task.completed}
                  onChange={() => toggleCompleted(task)} />
              )}

              {editId === task.id ? (
                <div className="edit-row">
                  <input type="text" value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveEdit(task.id)
                      if (e.key === 'Escape') { setEditId(null); setEditTitle('') }
                    }} autoFocus />
                  <button className="btn btn-sm" onClick={() => saveEdit(task.id)}>Guardar</button>
                  <button className="btn btn-sm btn-ghost" onClick={() => { setEditId(null); setEditTitle('') }}>
                    Cancelar
                  </button>
                </div>
              ) : (
                <>
                  <span className="task-text">
                    {!isAdmin && task.completed && <span className="check">&#10003;</span>}
                    {task.title}
                  </span>
                  {isAdmin && (
                    <span className="actions">
                      <button className="btn btn-sm" onClick={() => { setEditId(task.id); setEditTitle(task.title) }}>
                        Editar
                      </button>
                      <button className="btn btn-sm btn-danger" onClick={() => deleteTask(task.id)}>
                        Eliminar
                      </button>
                    </span>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default App
