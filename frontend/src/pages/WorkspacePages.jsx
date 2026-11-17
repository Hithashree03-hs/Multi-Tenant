import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.jsx";
import { useApi, useResource, toIsoDateTime } from "../hooks/useResource.js";
import {
  Alert, Button, Card, ConfirmButton, DataTable, EmptyState, Field, formatDate,
  Loading, Modal, PageHeader, Pagination, StatusBadge,
} from "../components/ui.jsx";

const PAGE_SIZE = 20;
const roles = { ADMIN: "Administrator", FACULTY: "Faculty", STUDENT: "Student" };
const projectStates = ["PLANNING", "ACTIVE", "COMPLETED", "ARCHIVED"];
const taskStates = ["TODO", "IN_PROGRESS", "BLOCKED", "DONE"];

function fromIsoDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function useAction() {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  async function run(path, options = {}) {
    setBusy(true); setError(""); setSuccess("");
    try { const result = await api(path, options); setSuccess(result.message || "Changes saved."); return result; }
    catch (failure) { setError(failure.message || "The change could not be saved."); throw failure; }
    finally { setBusy(false); }
  }
  return { run, busy, error, setError, success, setSuccess };
}

function ResourceState({ loading, error, reload, children }) {
  if (loading) return <Loading />;
  if (error) return <div className="content-stack"><Alert>{error}</Alert><Button variant="secondary" onClick={reload}>Try again</Button></div>;
  return children;
}

function MetricCard({ label, value, detail, glyph, tone = "violet", to }) {
  const body = <><div className={`metric-icon metric-${tone}`} aria-hidden="true">{glyph}</div><span className="metric-label">{label}</span><strong className="metric-value">{value ?? 0}</strong><span className="metric-detail">{detail}</span></>;
  return to ? <Link to={to} className="metric-card">{body}</Link> : <div className="metric-card">{body}</div>;
}

function StatusSummary({ title, values = {} }) {
  const entries = Object.entries(values);
  const max = Math.max(1, ...entries.map(([, count]) => count));
  return (
    <Card className="status-card">
      <div className="section-heading"><div><span className="eyebrow">LIVE SUMMARY</span><h2>{title}</h2></div></div>
      {entries.length ? (
        <div className="status-list">
          {entries.map(([label, count]) => (
            <div className="status-row" key={label}>
              <div className="status-row-label"><StatusBadge>{label}</StatusBadge><strong>{count}</strong></div>
              <div className="status-track"><span style={{ width: `${(count / max) * 100}%` }} /></div>
            </div>
          ))}
        </div>
      ) : <p className="muted small">No records to summarize yet.</p>}
    </Card>
  );
}

export function DashboardPage() {
  const { user } = useAuth();
  const { data, loading, error, reload } = useResource("/dashboard");
  const summary = data?.data || {};
  const common = [
    { label: "Projects", value: summary.projects, detail: "Visible to your account", glyph: "◈", tone: "peach", to: "/projects" },
    { label: "Tasks", value: summary.tasks ?? summary.assignedTasks, detail: "Current workload", glyph: "✓", tone: "blue", to: "/projects" },
    { label: "Notifications", value: summary.unreadNotifications, detail: "Unread updates", glyph: "◌", tone: "mint", to: "/notifications" },
  ];
  const metrics = user?.role === "ADMIN" ? [
    { label: "Students", value: summary.students, detail: "In your organization", glyph: "♙", tone: "violet", to: "/users" },
    { label: "Faculty", value: summary.faculty, detail: "In your organization", glyph: "♧", tone: "blue", to: "/users" },
    { label: "Courses", value: summary.courses, detail: "Across departments", glyph: "▤", tone: "peach", to: "/courses" },
    { label: "Enrollments", value: summary.enrollments, detail: "Active course links", glyph: "✓", tone: "mint", to: "/courses" },
    ...common,
  ] : user?.role === "FACULTY" ? [
    { label: "My courses", value: summary.courses, detail: "Assigned to you", glyph: "▤", tone: "violet", to: "/courses" },
    { label: "Enrollments", value: summary.enrollments, detail: "Across your courses", glyph: "✓", tone: "blue", to: "/courses" },
    { label: "Sessions", value: summary.attendanceSessions, detail: "Attendance sessions", glyph: "◷", tone: "peach", to: "/attendance" },
    ...common,
  ] : [
    { label: "My courses", value: summary.enrollments, detail: "Your enrollments", glyph: "▤", tone: "violet", to: "/enrollments" },
    { label: "Attendance", value: summary.attendanceRecords, detail: "Recorded for you", glyph: "◷", tone: "blue", to: "/attendance" },
    ...common,
  ];

  return <div className="content-stack">
    <PageHeader eyebrow="YOUR CAMPUS AT A GLANCE" title={`Good to see you, ${user?.name?.split(" ")[0] || "there"}.`} description="Here’s what’s moving across your workspace today." action={<span className="role-chip">{roles[user?.role] || user?.role}</span>} />
    <ResourceState loading={loading} error={error} reload={reload}>
      <div className="metric-grid">{metrics.map((metric) => <MetricCard key={metric.label} {...metric} />)}</div>
      <div className="dashboard-lower">
        <StatusSummary title="Project progress" values={summary.projectStatuses} />
        <StatusSummary title="Task progress" values={summary.taskStatuses} />
        <Card className="welcome-card"><div className="welcome-sparkle">✳</div><span className="eyebrow">A GOOD PLACE TO START</span><h2>Keep your campus work in motion.</h2><p>Pick up a project, check a course, or catch up on a campus update.</p><div className="welcome-links"><Link to="/projects">Explore projects <span>↗</span></Link><Link to="/courses">Browse courses <span>↗</span></Link></div></Card>
      </div>
    </ResourceState>
  </div>;
}

export function OrganizationPage() {
  const { user } = useAuth();
  const organizationPath = user?.organizationId
    ? `/organizations/${encodeURIComponent(user.organizationId)}`
    : "/organizations";
  const { data, setData, loading, error, reload } = useResource(organizationPath);
  const organization = Array.isArray(data?.data) ? data.data[0] : data?.data;
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const { run, busy, error: actionError } = useAction();
  async function save(payload) {
    const organizationId = organization?.id;
    if (!organizationId || organizationId !== user?.organizationId) {
      throw new Error("Your organization could not be confirmed. Reload the page and try again.");
    }
    const result = await run(`/organizations/${organizationId}`, { method: "PATCH", body: payload });
    if (!result?.data || result.data.id !== organizationId) {
      reload();
      throw new Error("The server did not confirm the updated organization. Reload the page and check the saved values.");
    }
    setData({ success: true, data: result.data });
    setEditing(false);
  }
  return <div className="content-stack"><PageHeader eyebrow="CAMPUS PROFILE" title="Organization" description="Your workspace is connected to this campus organization." action={user.role === "ADMIN" && <div className="header-actions">
    <Button variant="secondary" onClick={() => setAdding(true)}>+ Add organization</Button>
    {organization && <Button onClick={() => setEditing(true)}>Edit organization</Button>}
  </div>} />
    {actionError && !editing && <Alert>{actionError}</Alert>}
    <ResourceState loading={loading} error={error} reload={reload}>{organization ? <Card className="organization-card"><div className="org-monogram">{organization.name?.slice(0, 1)?.toUpperCase()}</div><div><span className="eyebrow">CURRENT WORKSPACE</span><h2>{organization.name}</h2><p className="muted">Campus slug <code>{organization.slug}</code></p><div className="org-meta"><span><b>Organization ID</b><code>{organization.id}</code></span><span><b>Created</b>{formatDate(organization.createdAt)}</span></div></div></Card> : <EmptyState title="No organization found">Contact your administrator to confirm this account’s organization access.</EmptyState>}</ResourceState>
    {editing && organization && <Modal title="Edit organization settings" onClose={() => setEditing(false)}><OrganizationForm initial={organization} onCancel={() => setEditing(false)} onSave={save} busy={busy} /></Modal>}
    {adding && <Modal title="Add organization" onClose={() => setAdding(false)}><OrganizationCreateForm onCancel={() => setAdding(false)} /></Modal>}
  </div>;
}

function OrganizationForm({ initial, onCancel, onSave, busy }) {
  const [name, setName] = useState(initial.name || "");
  const [slug, setSlug] = useState(initial.slug || "");
  const [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    setError("");
    const payload = {};
    if (name.trim() !== initial.name) payload.name = name.trim();
    if (slug.trim() !== initial.slug) payload.slug = slug.trim();
    if (!Object.keys(payload).length) {
      setError("Change the organization name or slug before saving.");
      return;
    }
    try { await onSave(payload); }
    catch (failure) { setError(failure.message); }
  }
  return <form className="stack-form" onSubmit={submit}><Alert>{error}</Alert>
    <Field label="Organization name" name="organization-name" required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />
    <Field label="Organization slug" name="organization-slug" required maxLength={63} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" value={slug} onChange={(event) => setSlug(event.target.value.toLowerCase())} hint="Lowercase letters and numbers separated by single hyphens." />
    <div className="form-actions"><Button variant="secondary" onClick={onCancel}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save organization"}</Button></div>
  </form>;
}

function OrganizationCreateForm({ onCancel, onCreated }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [error, setError] = useState("");

  function submit(event) {
    event.preventDefault();
    setError(
      "The secure platform-admin backend must be implemented before organizations can be created here."
    );
  }

  return (
    <form className="stack-form" onSubmit={submit}>
      {error && <Alert>{error}</Alert>}

      <Field
        label="Organization name"
        name="new-organization-name"
        required
        maxLength={120}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />

      <Field
        label="Organization slug"
        name="new-organization-slug"
        required
        maxLength={63}
        pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
        value={slug}
        onChange={(event) => setSlug(event.target.value.toLowerCase())}
        hint="Lowercase letters and numbers separated by single hyphens."
      />

      <div className="form-actions">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit">Create organization</Button>
      </div>
    </form>
  );
}

function DepartmentForm({ initial = {}, onCancel, onSave, busy }) {
  const [form, setForm] = useState({ name: initial.name || "", code: initial.code || "" });
  const [error, setError] = useState("");
  async function submit(event) { event.preventDefault(); setError(""); try { await onSave({ name: form.name.trim(), code: form.code.trim().toUpperCase() }); } catch (failure) { setError(failure.message); } }
  return <form className="stack-form" onSubmit={submit}><Alert>{error}</Alert>
    <Field label="Department name" name="department-name" required maxLength={120} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
    <Field label="Department code" name="department-code" required maxLength={20} value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} hint="Letters, numbers, and hyphens." />
    <div className="form-actions"><Button variant="secondary" onClick={onCancel}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save department"}</Button></div>
  </form>;
}

export function DepartmentsPage() {
  const { user } = useAuth();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState(null);
  const resource = useResource(`/departments?page=${page}&limit=${PAGE_SIZE}`);
  const { run, busy, error, setError } = useAction();
  const departments = resource.data?.data || [];
  const visible = departments.filter((item) => `${item.name} ${item.code}`.toLowerCase().includes(search.toLowerCase()));
  async function save(payload) {
    await run(modal.item ? `/departments/${modal.item.id}` : "/departments", { method: modal.item ? "PATCH" : "POST", body: payload });
    setModal(null); resource.reload();
  }
  async function remove(item) { try { await run(`/departments/${item.id}`, { method: "DELETE" }); resource.reload(); } catch {} }
  return <div className="content-stack"><PageHeader eyebrow="ACADEMIC STRUCTURE" title="Departments" description="Browse the academic homes that bring your courses together." action={user.role === "ADMIN" && <Button onClick={() => { setError(""); setModal({}); }}>＋ Add department</Button>} />
    {error && <Alert>{error}</Alert>}
    <ResourceState loading={resource.loading} error={resource.error} reload={resource.reload}>
      <Card className="toolbar-card"><div className="toolbar"><Field label="Search departments" name="department-search" type="search" placeholder="Name or code" value={search} onChange={(event) => setSearch(event.target.value)} /><span className="toolbar-count">{resource.data?.pagination?.total ?? departments.length} departments</span></div></Card>
      <Card className="data-card"><DataTable rows={visible} emptyTitle="No departments yet" emptyMessage={search ? "Try another search." : "Departments created by your campus will appear here."} columns={[
        { key: "name", label: "Department", render: (item) => <Link className="table-title" to={`/departments/${item.id}`}>{item.name}</Link> },
        { key: "code", label: "Code", render: (item) => <span className="code-pill">{item.code}</span> },
        { key: "createdAt", label: "Added", render: (item) => formatDate(item.createdAt) },
        ...(user.role === "ADMIN" ? [{ key: "actions", label: "Actions", render: (item) => <div className="table-actions"><Button variant="quiet" onClick={() => { setError(""); setModal({ item }); }}>Edit</Button><ConfirmButton message={`Delete ${item.name}? Courses may prevent this department from being deleted.`} onConfirm={() => remove(item)} /></div> }] : []),
      ]} /><Pagination pagination={resource.data?.pagination} onPage={setPage} /></Card>
    </ResourceState>
    {modal && <Modal title={modal.item ? "Edit department" : "Add department"} onClose={() => setModal(null)}><DepartmentForm initial={modal.item} onCancel={() => setModal(null)} onSave={save} busy={busy} /></Modal>}
  </div>;
}

export function DepartmentDetailPage() {
  const { id } = useParams();
  const { data, loading, error, reload } = useResource(`/departments/${id}`);
  const department = data?.data;
  return <div className="content-stack"><PageHeader eyebrow="DEPARTMENT" title={department?.name || "Department details"} description="Department details from your organization." action={<Link className="button button-secondary" to="/departments">← All departments</Link>} />
    <ResourceState loading={loading} error={error} reload={reload}>{department && <Card><div className="detail-grid"><span><small>Department code</small><strong>{department.code}</strong></span><span><small>Organization</small><strong>Current campus</strong></span><span><small>Created</small><strong>{formatDate(department.createdAt)}</strong></span><span><small>Last updated</small><strong>{formatDate(department.updatedAt)}</strong></span></div></Card>}</ResourceState>
  </div>;
}

function UserForm({ initial = {}, userRole, onCancel, onSave, busy }) {
  const editing = Boolean(initial.id);
  const [form, setForm] = useState({ name: initial.name || "", email: initial.email || "", role: initial.role || "STUDENT", password: "" });
  const [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault(); setError("");
    const payload = { name: form.name.trim(), email: form.email.trim() };
    if (!editing || userRole === "ADMIN") payload.role = form.role;
    if (form.password) payload.password = form.password;
    setForm((current) => ({ ...current, password: "" }));
    try { await onSave(payload); } catch (failure) { setError(failure.message); }
  }
  return <form className="stack-form" onSubmit={submit}><Alert>{error}</Alert>
    <Field label="Full name" name="user-name" required maxLength={120} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
    <Field label="Email" name="user-email" type="email" required maxLength={254} value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
    {(!editing || userRole === "ADMIN") && <Field as="select" label="Role" name="user-role" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}>
      <option value="STUDENT">Student</option>{userRole === "ADMIN" && <option value="FACULTY">Faculty</option>}
    </Field>}
    <Field label={editing ? "Temporary password (optional)" : "Temporary password"} name="user-password" type="password" autoComplete="new-password" minLength={8} maxLength={72} required={!editing} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} hint={editing ? "Leave blank to keep the current password." : "At least 8 characters. The user can change it through a future account flow."} />
    <div className="form-actions"><Button variant="secondary" onClick={onCancel}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? "Saving…" : editing ? "Save changes" : "Create account"}</Button></div>
  </form>;
}

export function UsersPage() {
  const { user } = useAuth();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("ALL");
  const [modal, setModal] = useState(null);
  const resource = useResource(`/users?page=${page}&limit=${PAGE_SIZE}`);
  const { run, busy, error, setError } = useAction();
  const people = resource.data?.data || [];
  const visible = people.filter((person) => `${person.name} ${person.email}`.toLowerCase().includes(search.toLowerCase()) && (roleFilter === "ALL" || person.role === roleFilter));
  async function save(payload) { await run(modal.item ? `/users/${modal.item.id}` : "/users", { method: modal.item ? "PATCH" : "POST", body: payload }); setModal(null); resource.reload(); }
  return <div className="content-stack"><PageHeader eyebrow="CAMPUS DIRECTORY" title="People" description={user.role === "FACULTY" ? "Find students in your organization." : "Manage student and faculty accounts in your organization."} action={user.role === "ADMIN" ? <Button onClick={() => { setError(""); setModal({}); }}>＋ Add person</Button> : null} />
    {error && <Alert>{error}</Alert>}
    <ResourceState loading={resource.loading} error={resource.error} reload={resource.reload}><Card className="toolbar-card"><div className="toolbar"><Field label="Search people" name="people-search" type="search" placeholder="Name or email" value={search} onChange={(event) => setSearch(event.target.value)} />{user.role === "ADMIN" && <Field as="select" label="Role" name="people-role" value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}><option value="ALL">All roles</option><option value="STUDENT">Students</option><option value="FACULTY">Faculty</option></Field>}<span className="toolbar-count">{resource.data?.pagination?.total ?? people.length} people</span></div></Card>
      <Card className="data-card"><DataTable rows={visible} emptyTitle="No matching people" emptyMessage={search ? "Try another name or email." : "No directory records are available yet."} columns={[
        { key: "name", label: "Person", render: (person) => <Link className="person-cell" to={`/users/${person.id}`}><span className="avatar avatar-table">{person.name?.split(/\s+/).map((part) => part[0]).slice(0, 2).join("")}</span><span><strong>{person.name}</strong><small>{person.email}</small></span></Link> },
        { key: "role", label: "Role", render: (person) => <StatusBadge>{person.role}</StatusBadge> },
        { key: "createdAt", label: "Joined", render: (person) => formatDate(person.createdAt) },
        ...(user.role === "ADMIN" ? [{ key: "actions", label: "Actions", render: (person) => person.role === "ADMIN" ? <span className="muted small">Protected account</span> : <Button variant="quiet" onClick={() => { setError(""); setModal({ item: person }); }}>Edit</Button> }] : []),
      ]} /><Pagination pagination={resource.data?.pagination} onPage={setPage} /></Card>
    </ResourceState>
    {modal && <Modal title={modal.item ? "Edit account" : "Create account"} onClose={() => setModal(null)}><UserForm initial={modal.item} userRole={user.role} onCancel={() => setModal(null)} onSave={save} busy={busy} /></Modal>}
  </div>;
}

export function UserDetailPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const resource = useResource(`/users/${id}`);
  const person = resource.data?.data;
  return <div className="content-stack"><PageHeader eyebrow="DIRECTORY PROFILE" title={person?.name || "Person details"} description="A safe account profile from the campus directory." action={<Link className="button button-secondary" to="/users">← People directory</Link>} />
    <ResourceState loading={resource.loading} error={resource.error} reload={resource.reload}>{person && <Card className="profile-card"><span className="avatar avatar-large">{person.name?.split(/\s+/).map((part) => part[0]).slice(0, 2).join("")}</span><div><StatusBadge>{person.role}</StatusBadge><h2>{person.name}</h2><p>{person.email}</p><div className="detail-grid"><span><small>Member since</small><strong>{formatDate(person.createdAt)}</strong></span><span><small>Account updated</small><strong>{formatDate(person.updatedAt)}</strong></span><span><small>Campus</small><strong>Your organization</strong></span></div>{user.role === "FACULTY" && <p className="muted small">Faculty accounts can view student profiles only.</p>}</div></Card>}</ResourceState>
  </div>;
}

function CourseForm({ initial = {}, departments = [], faculty = [], userRole, onCancel, onSave, busy }) {
  const editing = Boolean(initial.id);
  const [form, setForm] = useState({ code: initial.code || "", title: initial.title || "", description: initial.description || "", departmentId: initial.departmentId || (editing ? "" : departments[0]?.id || ""), facultyId: initial.facultyId || "", capacity: initial.capacity ?? 100, status: initial.status || "DRAFT" });
  const [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault(); setError("");
    const values = { code: form.code.trim().toUpperCase(), title: form.title.trim(), description: form.description.trim() || null, departmentId: form.departmentId, capacity: Number(form.capacity) };
    if (userRole === "ADMIN") { values.facultyId = form.facultyId || null; values.status = form.status; }
    const payload = {};
    if (!editing) Object.assign(payload, values);
    else {
      const originalValues = {
        code: String(initial.code || "").trim().toUpperCase(),
        title: String(initial.title || "").trim(),
        description: initial.description ?? null,
        departmentId: initial.departmentId,
        capacity: initial.capacity,
        ...(userRole === "ADMIN" ? { facultyId: initial.facultyId ?? null, status: initial.status } : {}),
      };
      for (const [key, value] of Object.entries(values)) {
        if (value !== originalValues[key]) payload[key] = value;
      }
      if (!Object.keys(payload).length) {
        setError("Change at least one course field before saving.");
        return;
      }
    }
    try { await onSave(payload); } catch (failure) { setError(failure.message); }
  }
  return <form className="stack-form" onSubmit={submit}><Alert>{error}</Alert>
    <div className="form-grid"><Field label="Course code" name="course-code" required maxLength={32} value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} /><Field label="Course title" name="course-title" required maxLength={160} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></div>
    <Field as="textarea" label="Description" name="course-description" rows={3} maxLength={4000} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
    <div className="form-grid"><Field as="select" label="Department" name="course-department" required value={form.departmentId} onChange={(event) => setForm({ ...form, departmentId: event.target.value })}>{departments.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.code}</option>)}</Field><Field label="Capacity" name="course-capacity" type="number" min="1" max="10000" required value={form.capacity} onChange={(event) => setForm({ ...form, capacity: event.target.value })} /></div>
    {userRole === "ADMIN" && <div className="form-grid"><Field as="select" label="Faculty member" name="course-faculty" value={form.facultyId} onChange={(event) => setForm({ ...form, facultyId: event.target.value })}><option value="">Unassigned</option>{faculty.filter((person) => person.role === "FACULTY").map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</Field><Field as="select" label="Course status" name="course-status" value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}><option value="DRAFT">Draft</option><option value="PUBLISHED">Published</option><option value="ARCHIVED">Archived</option></Field></div>}
    <div className="form-actions"><Button variant="secondary" onClick={onCancel}>Cancel</Button><Button type="submit" disabled={busy || !departments.length}>{busy ? "Saving…" : "Save course"}</Button></div>
    {!departments.length && <p className="form-note">Create a department before adding a course.</p>}
  </form>;
}

export function CoursesPage() {
  const { user } = useAuth();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [modal, setModal] = useState(null);
  const departmentsResource = useResource(`/departments?limit=100`);
  const facultyResource = useResource(user.role === "ADMIN" ? "/users?limit=100" : null);
  const path = `/courses?page=${page}&limit=${PAGE_SIZE}${departmentId ? `&departmentId=${encodeURIComponent(departmentId)}` : ""}`;
  const resource = useResource(path);
  const { run, busy, error, setError } = useAction();
  const departments = departmentsResource.data?.data || [];
  const courses = resource.data?.data || [];
  const visible = courses.filter((course) => `${course.code} ${course.title}`.toLowerCase().includes(search.toLowerCase()));
  const departmentName = (id) => departments.find((department) => department.id === id)?.name || "Department";

  async function save(payload) {
    const result = await run(modal.item ? `/courses/${modal.item.id}` : "/courses", { method: modal.item ? "PATCH" : "POST", body: payload });
    if (modal.item && result?.data && resource.data?.data?.some((course) => course.id === result.data.id)) {
      resource.setData({ ...resource.data, data: resource.data.data.map((course) => course.id === result.data.id ? result.data : course) });
    } else {
      resource.reload();
    }
    setModal(null);
  }
  return <div className="content-stack"><PageHeader eyebrow="LEARNING CATALOG" title="Courses" description={user.role === "STUDENT" ? "Explore published courses and open a course to manage your enrollment." : user.role === "FACULTY" ? "Your assigned courses and teaching information." : "Manage courses across your campus departments."} action={user.role !== "STUDENT" && <Button onClick={() => { setError(""); setModal({}); }}>＋ Add course</Button>} />
    {error && <Alert>{error}</Alert>}
    <ResourceState loading={resource.loading} error={resource.error} reload={resource.reload}><Card className="toolbar-card"><div className="toolbar"><Field label="Search courses" name="course-search" type="search" placeholder="Course code or title" value={search} onChange={(event) => setSearch(event.target.value)} /><Field as="select" label="Department" name="course-department-filter" value={departmentId} onChange={(event) => { setDepartmentId(event.target.value); setPage(1); }}><option value="">All departments</option>{departments.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</Field><span className="toolbar-count">{resource.data?.pagination?.total ?? courses.length} courses</span></div></Card>
      <div className="course-grid">{visible.length ? visible.map((course, index) => <Card className="course-card" key={course.id}><div className={`course-accent course-accent-${index % 4}`}><span>{course.code?.slice(0, 2)}</span><StatusBadge>{course.status}</StatusBadge></div><div className="course-card-body"><span className="eyebrow">{departmentName(course.departmentId)}</span><h2>{course.title}</h2><span className="course-code">{course.code}</span><p>{course.description || "A course in your campus learning catalog."}</p><div className="course-card-meta"><span><b>{course.capacity}</b> seats</span><span>{course.facultyId ? "Faculty assigned" : "Faculty TBD"}</span></div><Link className="button button-secondary button-full" to={`/courses/${course.id}`}>View course <span aria-hidden="true">↗</span></Link>
        {user.role !== "STUDENT" && (user.role === "ADMIN" || course.facultyId === user.id) && <Button variant="quiet" className="button-full" onClick={() => { setError(""); setModal({ item: course }); }}>Edit course</Button>}
      </div></Card>) : <Card className="grid-empty"><EmptyState title="No courses found">{search ? "Try a different search or department." : "Courses available to your account will appear here."}</EmptyState></Card>}</div>
      <Pagination pagination={resource.data?.pagination} onPage={setPage} />
    </ResourceState>
    {modal && <Modal title={modal.item ? "Edit course" : "Create course"} onClose={() => setModal(null)} wide><CourseForm initial={modal.item} departments={departments} faculty={facultyResource.data?.data || []} userRole={user.role} onCancel={() => setModal(null)} onSave={save} busy={busy} /></Modal>}
  </div>;
}

export function CourseDetailPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const { run, busy, error, setError } = useAction();
  const courseResource = useResource(`/courses/${id}`);
  const course = courseResource.data?.data;
  const isStudent = user.role === "STUDENT";
  const canManage = user.role === "ADMIN" || user.role === "FACULTY";
  const enrollmentResource = useResource(isStudent ? "/enrollments/me?limit=100" : null);
  const rosterResource = useResource(course && canManage ? `/courses/${id}/enrollments?limit=100` : null);
  const enrollment = (enrollmentResource.data?.data || []).find((item) => item.courseId === id);
  const departmentsResource = useResource("/departments?limit=100");
  const departments = departmentsResource.data?.data || [];
  const department = departments.find((item) => item.id === course?.departmentId);

  async function enroll() { try { await run(`/courses/${id}/enroll`, { method: "POST" }); enrollmentResource.reload(); } catch {} }
  async function cancelEnrollment() { try { await run(`/courses/${id}/enroll`, { method: "DELETE" }); enrollmentResource.reload(); } catch {} }
  async function removeStudent(studentId) { try { await run(`/courses/${id}/enrollments/${studentId}`, { method: "DELETE" }); rosterResource.reload(); } catch {} }

  return <div className="content-stack"><PageHeader eyebrow="COURSE DETAILS" title={course?.title || "Course"} description={course ? `${course.code} · ${department?.name || "Department"}` : "Details and enrollment information."} action={<Link className="button button-secondary" to="/courses">← Course catalog</Link>} />
    {error && <Alert>{error}</Alert>}
    {departmentsResource.error && <Alert variant="info">Course details loaded, but department information could not be loaded.</Alert>}
    <ResourceState loading={courseResource.loading} error={courseResource.error} reload={courseResource.reload}>{course && <>
      <Card className="course-detail-card"><div className="course-detail-top"><div><span className="eyebrow">{course.code}</span><h2>{course.title}</h2><p>{course.description || "No description has been added for this course."}</p></div><StatusBadge>{course.status}</StatusBadge></div><div className="detail-grid"><span><small>Department</small><strong>{department?.name || "—"}</strong></span><span><small>Capacity</small><strong>{course.capacity} seats</strong></span><span><small>Instructor</small><strong>{course.facultyId ? "Faculty member assigned" : "To be assigned"}</strong></span><span><small>Created</small><strong>{formatDate(course.createdAt)}</strong></span></div>
        {isStudent && <div className="course-action-row">{enrollmentResource.loading ? <span className="muted" role="status">Checking your enrollment…</span> : enrollmentResource.error ? <div><Alert>{enrollmentResource.error}</Alert><Button variant="secondary" onClick={enrollmentResource.reload}>Try again</Button></div> : enrollment ? <><span className="enrolled-note"><span>✓</span> You’re enrolled since {formatDate(enrollment.enrolledAt)}</span><ConfirmButton variant="danger" message="Cancel your enrollment in this course?" onConfirm={cancelEnrollment} disabled={busy}>Cancel enrollment</ConfirmButton></> : course.status === "PUBLISHED" ? <Button disabled={busy} onClick={enroll}>{busy ? "Processing…" : "Enroll in course"}</Button> : <span className="muted">This course is not open for enrollment.</span>}</div>}
      </Card>
      {canManage && <Card className="data-card"><div className="section-heading"><div><span className="eyebrow">CLASS ROSTER</span><h2>Enrolled students</h2></div><span className="toolbar-count">{rosterResource.data?.pagination?.total ?? 0} students</span></div><ResourceState loading={rosterResource.loading} error={rosterResource.error} reload={rosterResource.reload}><DataTable rows={rosterResource.data?.data || []} emptyTitle="No students enrolled" emptyMessage="Students who enroll will appear in this roster." columns={[
        { key: "student", label: "Student", render: (row) => <span><strong>{row.student?.name}</strong><small className="table-subline">{row.student?.email}</small></span> },
        { key: "enrolledAt", label: "Enrolled", render: (row) => formatDate(row.enrolledAt) },
        ...(user.role === "ADMIN" ? [{ key: "actions", label: "Actions", render: (row) => <ConfirmButton message={`Remove ${row.student?.name} from this course?`} onConfirm={() => removeStudent(row.studentId)} disabled={busy}>Remove</ConfirmButton> }] : []),
      ]} /></ResourceState></Card>}
    </>}</ResourceState>
  </div>;
}

export function EnrollmentsPage() {
  const [page, setPage] = useState(1);
  const resource = useResource(`/enrollments/me?page=${page}&limit=${PAGE_SIZE}`);
  const { run, busy, error } = useAction();
  async function cancel(courseId) { try { await run(`/courses/${courseId}/enroll`, { method: "DELETE" }); resource.reload(); } catch {} }
  const enrollments = resource.data?.data || [];
  return <div className="content-stack"><PageHeader eyebrow="YOUR LEARNING PLAN" title="My enrollments" description="Courses you’ve joined in your campus organization." action={<Link className="button button-primary" to="/courses">Browse courses <span>↗</span></Link>} />
    {error && <Alert>{error}</Alert>}
    <ResourceState loading={resource.loading} error={resource.error} reload={resource.reload}><Card className="data-card"><DataTable rows={enrollments} emptyTitle="No enrollments yet" emptyMessage="Browse the course catalog to find a class that fits your plan." columns={[
      { key: "course", label: "Course", render: (row) => <Link className="table-title" to={`/courses/${row.courseId}`}>{row.course?.title}</Link> },
      { key: "code", label: "Code", render: (row) => <span className="code-pill">{row.course?.code}</span> },
      { key: "status", label: "Status", render: (row) => <StatusBadge>{row.course?.status}</StatusBadge> },
      { key: "enrolledAt", label: "Enrolled on", render: (row) => formatDate(row.enrolledAt) },
      { key: "actions", label: "Actions", render: (row) => <ConfirmButton message={`Cancel enrollment in ${row.course?.title}?`} onConfirm={() => cancel(row.courseId)} disabled={busy}>Cancel</ConfirmButton> },
    ]} /></Card><Pagination pagination={resource.data?.pagination} onPage={setPage} /></ResourceState>
  </div>;
}

export function AttendancePage() {
  const { user } = useAuth();
  const isStudent = user.role === "STUDENT";
  const [studentPage, setStudentPage] = useState(1);
  const coursesResource = useResource(isStudent ? null : "/courses?limit=100");
  const sessionsResource = useResource(isStudent ? null : "/attendance/sessions?limit=100");
  const studentResource = useResource(isStudent ? `/attendance/me?page=${studentPage}&limit=${PAGE_SIZE}` : null);
  const [selectedId, setSelectedId] = useState("");
  const [sessionForm, setSessionForm] = useState({ courseId: "", title: "", startsAt: "", endsAt: "" });
  const [newRecord, setNewRecord] = useState({ studentId: "", status: "" });
  const [reportCourseId, setReportCourseId] = useState("");
  const [report, setReport] = useState(null);
  const [reportError, setReportError] = useState("");
  const { run, busy, error, setError, success } = useAction();
  const api = useApi();
  const sessions = sessionsResource.data?.data || [];
  const courses = coursesResource.data?.data || [];
  const selected = sessions.find((session) => session.id === selectedId) || sessions[0];
  const recordsResource = useResource(selected ? `/attendance/sessions/${selected.id}/records?limit=100` : null);
  const rosterResource = useResource(selected ? `/courses/${selected.courseId}/enrollments?limit=100` : null);
  const records = recordsResource.data?.data || [];
  const roster = rosterResource.data?.data || [];

  useEffect(() => {
    if (!selectedId && sessions.length) setSelectedId(sessions[0].id);
    if (selectedId && !sessions.some((item) => item.id === selectedId)) setSelectedId(sessions[0]?.id || "");
  }, [sessions, selectedId]);
  useEffect(() => {
    if (!sessionForm.courseId && courses.length) setSessionForm((current) => ({ ...current, courseId: courses[0].id }));
  }, [courses, sessionForm.courseId]);

  async function createSession(event) {
    event.preventDefault(); setError("");
    try {
      const result = await run("/attendance/sessions", { method: "POST", body: { courseId: sessionForm.courseId, title: sessionForm.title.trim(), startsAt: toIsoDateTime(sessionForm.startsAt), endsAt: sessionForm.endsAt ? toIsoDateTime(sessionForm.endsAt) : null } });
      setSessionForm((current) => ({ ...current, title: "", startsAt: "", endsAt: "" }));
      setSelectedId(result.data.id); sessionsResource.reload();
    } catch {}
  }
  async function recordAttendance(event) {
    event.preventDefault(); if (!selected || !newRecord.studentId || !newRecord.status) return;
    try {
      const studentId = newRecord.studentId;
      const courseId = selected.courseId;
      const result = await run(`/attendance/sessions/${selected.id}/records`, { method: "POST", body: newRecord });
      const savedRecord = result.data;
      const rosterStudent = roster.find((row) => row.studentId === studentId)?.student;
      recordsResource.setData((current) => {
        if (!current) return current;
        const rows = current.data || [];
        const index = rows.findIndex((row) => row.id === savedRecord.id || row.enrollmentId === savedRecord.enrollmentId || row.enrollment?.student?.id === studentId);
        const previous = index >= 0 ? rows[index] : null;
        const updatedRecord = { ...previous, ...savedRecord, enrollment: previous?.enrollment || { student: rosterStudent } };
        const nextRows = rows.slice();
        if (index >= 0) nextRows[index] = updatedRecord;
        else nextRows.push(updatedRecord);
        const total = (current.pagination?.total ?? rows.length) + (result.created ? 1 : 0);
        return {
          ...current,
          data: nextRows,
          ...(current.pagination ? { pagination: { ...current.pagination, total, totalPages: Math.ceil(total / current.pagination.limit) } } : {}),
        };
      });
      setNewRecord({ studentId: "", status: "" });
      if (report && reportCourseId === courseId) {
        try { await refreshAttendanceReport(courseId); }
        catch (failure) { setReportError(failure.message); }
      }
    }
    catch {}
  }
  async function updateRecord(recordId, status) {
    try { await run(`/attendance/records/${recordId}`, { method: "PATCH", body: { status } }); recordsResource.reload(); } catch {}
  }
  async function deleteSession(sessionId) {
    try { await run(`/attendance/sessions/${sessionId}`, { method: "DELETE" }); setSelectedId(""); sessionsResource.reload(); } catch {}
  }
  async function loadReport(event) {
    event.preventDefault(); setReport(null); setReportError("");
    try { await refreshAttendanceReport(reportCourseId); }
    catch (failure) { setReportError(failure.message); }
  }

  async function refreshAttendanceReport(courseId) {
    const result = await api(`/attendance/reports/course/${courseId}`);
    setReport(result.data);
    setReportError("");
    return result.data;
  }

  if (isStudent) return <div className="content-stack"><PageHeader eyebrow="YOUR CLASS RECORD" title="Attendance" description="A private view of attendance recorded for your course enrollments." />
    <ResourceState loading={studentResource.loading} error={studentResource.error} reload={studentResource.reload}><Card className="data-card"><DataTable rows={studentResource.data?.data || []} emptyTitle="No attendance recorded" emptyMessage="Your attendance history will appear here when an instructor records it." columns={[
      { key: "course", label: "Course", render: (row) => <span><strong>{row.session?.course?.title || "Course"}</strong><small className="table-subline">{row.session?.course?.code}</small></span> },
      { key: "session", label: "Session", render: (row) => row.session?.title },
      { key: "date", label: "Date", render: (row) => formatDate(row.session?.startsAt) },
      { key: "status", label: "Status", render: (row) => <StatusBadge>{row.status}</StatusBadge> },
      { key: "markedAt", label: "Recorded", render: (row) => formatDate(row.markedAt) },
    ]} /><Pagination pagination={studentResource.data?.pagination} onPage={setStudentPage} /></Card></ResourceState>
  </div>;

  return <div className="content-stack"><PageHeader eyebrow="CLASS ENGAGEMENT" title="Attendance" description="Create class sessions, record attendance, and review course summaries." />
    {error && <Alert>{error}</Alert>}{success && <Alert variant="success">{success}</Alert>}
    <ResourceState loading={sessionsResource.loading || coursesResource.loading} error={sessionsResource.error || coursesResource.error} reload={() => { sessionsResource.reload(); coursesResource.reload(); }}>
      <div className="attendance-grid"><Card className="attendance-create"><span className="eyebrow">NEW SESSION</span><h2>Set up attendance</h2><form className="stack-form" onSubmit={createSession}>
        <Field as="select" label="Course" name="session-course" required value={sessionForm.courseId} onChange={(event) => setSessionForm({ ...sessionForm, courseId: event.target.value })}>{courses.map((course) => <option key={course.id} value={course.id}>{course.code} · {course.title}</option>)}</Field>
        <Field label="Session name" name="session-title" required maxLength={160} placeholder="e.g. Week 4 lecture" value={sessionForm.title} onChange={(event) => setSessionForm({ ...sessionForm, title: event.target.value })} />
        <Field label="Starts at" name="session-start" type="datetime-local" required value={sessionForm.startsAt} onChange={(event) => setSessionForm({ ...sessionForm, startsAt: event.target.value })} />
        <Field label="Ends at (optional)" name="session-end" type="datetime-local" value={sessionForm.endsAt} onChange={(event) => setSessionForm({ ...sessionForm, endsAt: event.target.value })} />
        <Button type="submit" disabled={busy || !courses.length}>{busy ? "Creating…" : "Create session"}</Button>
        {!courses.length && <p className="form-note">Create or assign a course before scheduling attendance.</p>}
      </form></Card>
      <Card className="session-list-card"><div className="section-heading"><div><span className="eyebrow">YOUR CLASSES</span><h2>Attendance sessions</h2></div><span className="toolbar-count">{sessionsResource.data?.pagination?.total ?? sessions.length} sessions</span></div>
        {sessions.length ? <div className="session-list">{sessions.map((session) => {
          const course = courses.find((item) => item.id === session.courseId);
          return <div className={`session-item ${selected?.id === session.id ? "session-selected" : ""}`} key={session.id}>
            <button className="session-main" onClick={() => setSelectedId(session.id)}><span className="session-date">{new Date(session.startsAt).toLocaleDateString(undefined, { day: "2-digit", month: "short" })}</span><span><strong>{session.title}</strong><small>{course?.code || "Course"} · {formatDate(session.startsAt, { year: undefined })}</small></span><span className="session-arrow">→</span></button>
            {user.role === "ADMIN" && <ConfirmButton message={`Delete the ${session.title} session? Existing attendance records will prevent deletion.`} onConfirm={() => deleteSession(session.id)} disabled={busy}>Delete</ConfirmButton>}
          </div>;
        })}</div> : <EmptyState title="No sessions yet">Create a session for one of your courses to start recording attendance.</EmptyState>}
      </Card></div>

      {selected && <Card className="data-card"><div className="section-heading"><div><span className="eyebrow">{courses.find((course) => course.id === selected.courseId)?.code || "COURSE"}</span><h2>{selected.title}</h2></div><StatusBadge>{recordsResource.data?.pagination?.total ?? records.length} records</StatusBadge></div>
        <ResourceState loading={recordsResource.loading || rosterResource.loading} error={recordsResource.error || rosterResource.error} reload={() => { recordsResource.reload(); rosterResource.reload(); }}>
          <form className="inline-form" onSubmit={recordAttendance}><Field as="select" label="Enrolled student" name="attendance-student" required value={newRecord.studentId} onChange={(event) => setNewRecord({ ...newRecord, studentId: event.target.value })}><option value="">Choose a student…</option>{roster.map((row) => <option key={row.studentId} value={row.studentId}>{row.student?.name} · {row.student?.email}</option>)}</Field><Field as="select" label="Attendance status" name="attendance-status" required value={newRecord.status} onChange={(event) => setNewRecord({ ...newRecord, status: event.target.value })}><option value="" disabled>Select attendance status…</option><option value="PRESENT">Present</option><option value="ABSENT">Absent</option><option value="LATE">Late</option><option value="EXCUSED">Excused</option></Field><Button type="submit" disabled={busy || !roster.length || !newRecord.studentId || !newRecord.status}>Record attendance</Button></form>
          <DataTable rows={records} emptyTitle="Attendance has not been recorded" emptyMessage="Choose an enrolled student above to add the first record." columns={[
            { key: "student", label: "Student", render: (row) => <span><strong>{row.enrollment?.student?.name}</strong><small className="table-subline">{row.enrollment?.student?.email}</small></span> },
            { key: "status", label: "Status", render: (row) => <select aria-label={`Attendance status for ${row.enrollment?.student?.name}`} className="table-select" value={row.status} onChange={(event) => updateRecord(row.id, event.target.value)}><option value="PRESENT">Present</option><option value="ABSENT">Absent</option><option value="LATE">Late</option><option value="EXCUSED">Excused</option></select> },
            { key: "markedAt", label: "Recorded", render: (row) => formatDate(row.markedAt) },
          ]} />
        </ResourceState>
      </Card>}
      <Card className="report-card"><div><span className="eyebrow">COURSE REPORT</span><h2>Attendance summary</h2><p className="muted">Counts come from recorded attendance entries.</p></div><form className="inline-form report-form" onSubmit={loadReport}><Field as="select" label="Course" name="report-course" required value={reportCourseId} onChange={(event) => setReportCourseId(event.target.value)}><option value="">Choose a course…</option>{courses.map((course) => <option key={course.id} value={course.id}>{course.code} · {course.title}</option>)}</Field><Button variant="secondary" type="submit" disabled={!reportCourseId}>Show report</Button></form>
        {reportError && <Alert>{reportError}</Alert>}{report && <div className="report-values">{Object.entries(report.totals).map(([status, count]) => <div key={status}><StatusBadge>{status}</StatusBadge><strong>{count}</strong></div>)}<div className="report-total"><span>Total records</span><strong>{report.total}</strong></div></div>}
      </Card>
    </ResourceState>
  </div>;
}

function ProjectForm({ initial = {}, onCancel, onSave, busy }) {
  const [form, setForm] = useState({ title: initial.title || "", description: initial.description || "", startsAt: initial.startsAt ? new Date(initial.startsAt).toISOString().slice(0, 16) : "", dueAt: initial.dueAt ? new Date(initial.dueAt).toISOString().slice(0, 16) : "", status: initial.status || "PLANNING" });
  const [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault(); setError("");
    const payload = { title: form.title.trim(), description: form.description.trim() || null, startsAt: toIsoDateTime(form.startsAt), dueAt: toIsoDateTime(form.dueAt) };
    if (initial.id) payload.status = form.status;
    try { await onSave(payload); } catch (failure) { setError(failure.message); }
  }
  return <form className="stack-form" onSubmit={submit}><Alert>{error}</Alert>
    <Field label="Project title" name="project-title" required maxLength={160} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
    <Field as="textarea" label="Description" name="project-description" rows={4} maxLength={4000} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
    <div className="form-grid"><Field label="Starts at" name="project-start" type="datetime-local" value={form.startsAt} onChange={(event) => setForm({ ...form, startsAt: event.target.value })} /><Field label="Due at" name="project-due" type="datetime-local" value={form.dueAt} onChange={(event) => setForm({ ...form, dueAt: event.target.value })} /></div>
    {initial.id && <Field as="select" label="Status" name="project-status" value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}>{projectStates.map((status) => <option key={status} value={status}>{status.replaceAll("_", " ")}</option>)}</Field>}
    <div className="form-actions"><Button variant="secondary" onClick={onCancel}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save project"}</Button></div>
  </form>;
}

export function ProjectsPage() {
  const { user } = useAuth();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [modal, setModal] = useState(false);
  const resource = useResource(`/projects?page=${page}&limit=${PAGE_SIZE}`);
  const { run, busy, error, setError } = useAction();
  const projects = resource.data?.data || [];
  const visible = projects.filter((project) => `${project.title} ${project.description || ""}`.toLowerCase().includes(search.toLowerCase()) && (statusFilter === "ALL" || project.status === statusFilter));
  async function save(payload) { await run("/projects", { method: "POST", body: payload }); setModal(false); resource.reload(); }

  return <div className="content-stack"><PageHeader eyebrow="COLLABORATION SPACE" title="Projects" description={user.role === "ADMIN" ? "A view of projects across your organization." : "Shared work you own or have joined."} action={<Button onClick={() => { setError(""); setModal(true); }}>＋ New project</Button>} />
    {error && <Alert>{error}</Alert>}
    <ResourceState loading={resource.loading} error={resource.error} reload={resource.reload}><Card className="toolbar-card"><div className="toolbar"><Field label="Search projects" name="project-search" type="search" placeholder="Project title" value={search} onChange={(event) => setSearch(event.target.value)} /><Field as="select" label="Project status" name="project-status-filter" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="ALL">All statuses</option>{projectStates.map((status) => <option key={status} value={status}>{status.replaceAll("_", " ")}</option>)}</Field><span className="toolbar-count">{resource.data?.pagination?.total ?? projects.length} projects</span></div></Card>
      <div className="project-grid">{visible.length ? visible.map((project, index) => <Card className="project-card" key={project.id}><div className={`project-card-accent project-color-${index % 4}`}><span>PROJECT {String(index + 1).padStart(2, "0")}</span><StatusBadge>{project.status}</StatusBadge></div><div className="project-card-body"><h2>{project.title}</h2><p>{project.description || "A collaborative project in your campus workspace."}</p><div className="project-dates"><span><small>Due date</small><b>{formatDate(project.dueAt)}</b></span><span><small>Last updated</small><b>{formatDate(project.updatedAt)}</b></span></div><Link className="button button-secondary button-full" to={`/projects/${project.id}`}>Open project <span aria-hidden="true">↗</span></Link></div></Card>) : <Card className="grid-empty"><EmptyState title="No projects to show">{search || statusFilter !== "ALL" ? "Adjust your search or filter." : "Create a project to start collaborating with your campus community."}</EmptyState></Card>}</div>
      <Pagination pagination={resource.data?.pagination} onPage={setPage} />
    </ResourceState>
    {modal && <Modal title="Create a project" onClose={() => setModal(false)} wide><ProjectForm onCancel={() => setModal(false)} onSave={save} busy={busy} /></Modal>}
  </div>;
}

function TaskForm({ initial = {}, members, onCancel, onSave, busy }) {
  const editing = Boolean(initial.id);
  const [form, setForm] = useState({ title: initial.title || "", description: initial.description || "", priority: initial.priority || "NORMAL", dueAt: fromIsoDateTime(initial.dueAt), assigneeId: initial.assigneeId || "" });
  const [error, setError] = useState("");
  async function submit(event) { event.preventDefault(); setError(""); try { await onSave({ title: form.title.trim(), description: form.description.trim() || null, priority: form.priority, dueAt: toIsoDateTime(form.dueAt), assigneeId: form.assigneeId || null }); } catch (failure) { setError(failure.message); } }
  return <form className="stack-form" onSubmit={submit}><Alert>{error}</Alert>
    <Field label="Task title" name="task-title" maxLength={160} required value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
    <Field as="textarea" label="Description" name="task-description" rows={3} maxLength={4000} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
    <div className="form-grid"><Field as="select" label="Priority" name="task-priority" value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })}><option value="LOW">Low</option><option value="NORMAL">Normal</option><option value="HIGH">High</option><option value="URGENT">Urgent</option></Field><Field label="Due at" name="task-due" type="datetime-local" value={form.dueAt} onChange={(event) => setForm({ ...form, dueAt: event.target.value })} /></div>
    <Field as="select" label="Assignee" name="task-assignee" value={form.assigneeId} onChange={(event) => setForm({ ...form, assigneeId: event.target.value })}><option value="">Unassigned</option>{members.map((member) => <option key={member.userId} value={member.userId}>{member.user?.name || member.userId}</option>)}</Field>
    <div className="form-actions"><Button variant="secondary" onClick={onCancel}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? "Saving…" : editing ? "Save changes" : "Create task"}</Button></div>
  </form>;
}

export function ProjectDetailPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const projectResource = useResource(`/projects/${id}`);
  const project = projectResource.data?.data;
  const membersResource = useResource(`/projects/${id}/members?limit=100`);
  const tasksResource = useResource(`/projects/${id}/tasks?limit=100`);
  const commentsResource = useResource(`/projects/${id}/comments?limit=100`);
  const documentsResource = useResource(`/projects/${id}/documents?limit=100`);
  const { run, busy, error, setError, success } = useAction();
  const [projectModal, setProjectModal] = useState(false);
  const [taskModal, setTaskModal] = useState(null);
  const [memberId, setMemberId] = useState("");
  const [comment, setComment] = useState("");
  const [editingComment, setEditingComment] = useState(null);
  const [editedComment, setEditedComment] = useState("");
  const members = membersResource.data?.data || [];
  const tasks = tasksResource.data?.data || [];
  const comments = commentsResource.data?.data || [];
  const isOwner = project?.ownerId === user.id;
  const canManage = user.role === "ADMIN" || isOwner;
  const canUpdateProjectStatus = canManage && project;
  const transitions = { PLANNING: ["ACTIVE", "ARCHIVED"], ACTIVE: ["COMPLETED", "ARCHIVED"], COMPLETED: ["ARCHIVED"], ARCHIVED: [] };
  const taskTransitions = { TODO: ["IN_PROGRESS", "BLOCKED"], IN_PROGRESS: ["BLOCKED", "DONE"], BLOCKED: ["IN_PROGRESS", "DONE"], DONE: [] };

  async function saveProject(payload) { await run(`/projects/${id}`, { method: "PATCH", body: payload }); setProjectModal(false); projectResource.reload(); }
  async function addMember(event) { event.preventDefault(); try { await run(`/projects/${id}/members`, { method: "POST", body: { userId: memberId.trim() } }); setMemberId(""); membersResource.reload(); } catch {} }
  async function removeMember(member) { try { await run(`/projects/${id}/members/${member.userId}`, { method: "DELETE" }); membersResource.reload(); } catch {} }
  async function saveTask(payload) {
    const editing = Boolean(taskModal?.id);
    await run(editing ? `/projects/${id}/tasks/${taskModal.id}` : `/projects/${id}/tasks`, { method: editing ? "PATCH" : "POST", body: payload });
    setTaskModal(null);
    tasksResource.reload();
  }
  async function setTaskStatus(task, status) { try { await run(`/projects/${id}/tasks/${task.id}`, { method: "PATCH", body: { status } }); tasksResource.reload(); } catch {} }
  async function deleteTask(task) { try { await run(`/projects/${id}/tasks/${task.id}`, { method: "DELETE" }); tasksResource.reload(); } catch {} }
  async function postComment(event) { event.preventDefault(); if (!comment.trim()) return; try { await run(`/projects/${id}/comments`, { method: "POST", body: { content: comment.trim() } }); setComment(""); commentsResource.reload(); } catch {} }
  async function saveComment(event) {
    event.preventDefault();
    if (!editedComment.trim()) return;
    try {
      await run(`/projects/${id}/comments/${editingComment.id}`, { method: "PATCH", body: { content: editedComment.trim() } });
      setEditingComment(null);
      setEditedComment("");
      commentsResource.reload();
    } catch {}
  }
  async function deleteComment(item) { try { await run(`/projects/${id}/comments/${item.id}`, { method: "DELETE" }); commentsResource.reload(); } catch {} }
  async function changeProjectStatus(status) { try { await run(`/projects/${id}`, { method: "PATCH", body: { status } }); projectResource.reload(); } catch {} }

  return <div className="content-stack"><PageHeader eyebrow="PROJECT SPACE" title={project?.title || "Project"} description={project?.description || "Work together, track tasks, and keep discussion in one place."} action={<div className="header-actions"><Link className="button button-secondary" to="/projects">← All projects</Link>{canManage && project && <Button variant="secondary" onClick={() => setProjectModal(true)}>Edit project</Button>}</div>} />
    {error && <Alert>{error}</Alert>}{success && <Alert variant="success">{success}</Alert>}
    <ResourceState loading={projectResource.loading} error={projectResource.error} reload={projectResource.reload}>{project && <>
      <Card className="project-overview-card"><div className="project-overview-heading"><div><span className="eyebrow">PROJECT OVERVIEW</span><h2>{project.title}</h2></div><StatusBadge>{project.status}</StatusBadge></div><div className="detail-grid"><span><small>Owner</small><strong>{isOwner ? "You" : project.ownerId === user.id ? "You" : "Project owner"}</strong></span><span><small>Starts</small><strong>{formatDate(project.startsAt)}</strong></span><span><small>Due date</small><strong>{formatDate(project.dueAt)}</strong></span><span><small>Updated</small><strong>{formatDate(project.updatedAt)}</strong></span></div>
        {canUpdateProjectStatus && transitions[project.status]?.length > 0 && <div className="status-actions"><span>Move project to</span>{transitions[project.status].map((status) => <Button key={status} variant="quiet" disabled={busy} onClick={() => changeProjectStatus(status)}>{status.replaceAll("_", " ")}</Button>)}</div>}
      </Card>
      <div className="project-work-grid"><Card className="project-panel"><div className="section-heading"><div><span className="eyebrow">PROJECT WORK</span><h2>Tasks <span className="count-dot">{tasks.length}</span></h2></div><Button variant="secondary" onClick={() => setTaskModal({})}>＋ Add task</Button></div>
        <ResourceState loading={tasksResource.loading} error={tasksResource.error} reload={tasksResource.reload}><div className="task-list">{tasks.length ? tasks.map((task) => {
          const isAssignee = task.assigneeId === user.id;
          const canEdit = canManage || task.createdById === user.id;
          const canChangeStatus = canEdit || isAssignee;
          return <div className="task-row" key={task.id}><span className={`task-check task-${task.status.toLowerCase().replace("_", "-")}`}>{task.status === "DONE" ? "✓" : "·"}</span><div className="task-main"><strong>{task.title}</strong>{task.description && <small>{task.description}</small>}<div className="task-meta"><StatusBadge>{task.priority}</StatusBadge><span>Due {formatDate(task.dueAt)}</span><span>{members.find((member) => member.userId === task.assigneeId)?.user?.name || (task.assigneeId ? "Assigned member" : "Unassigned")}</span></div></div>
            <select className="table-select task-status-select" aria-label={`Task status for ${task.title}`} disabled={!canChangeStatus || busy} value={task.status} onChange={(event) => setTaskStatus(task, event.target.value)}>{[task.status, ...(taskTransitions[task.status] || [])].map((status) => <option value={status} key={status}>{status.replaceAll("_", " ")}</option>)}</select>
            {canEdit && <Button variant="quiet" disabled={busy} onClick={() => setTaskModal(task)}>Edit</Button>}
            {(canManage || task.createdById === user.id) && <ConfirmButton message={`Delete task “${task.title}”? Comments or documents may prevent deletion.`} onConfirm={() => deleteTask(task)} disabled={busy}>Delete</ConfirmButton>}
          </div>;
        }) : <EmptyState title="No tasks yet">Add a task to give the project a clear next step.</EmptyState>}</div></ResourceState>
      </Card>
      <Card className="project-panel"><div className="section-heading"><div><span className="eyebrow">COLLABORATORS</span><h2>Members <span className="count-dot">{members.length}</span></h2></div></div>
        <ResourceState loading={membersResource.loading} error={membersResource.error} reload={membersResource.reload}><div className="member-list">{members.map((member) => <div className="member-row" key={member.id}><span className="avatar avatar-small">{member.user?.name?.split(/\s+/).map((part) => part[0]).slice(0, 2).join("")}</span><span><strong>{member.user?.name || "Member"}</strong><small>{member.user?.role} · {member.user?.email}</small></span>{canManage && member.userId !== project.ownerId && <ConfirmButton message={`Remove ${member.user?.name} from this project? Their existing task assignment may remain.`} onConfirm={() => removeMember(member)} disabled={busy}>Remove</ConfirmButton>}</div>)}</div>
          {canManage && <form className="member-add-form" onSubmit={addMember}><Field label="Add campus member by account ID" name="member-id" required placeholder="Paste user ID" value={memberId} onChange={(event) => setMemberId(event.target.value)} hint="The backend verifies the account belongs to this organization." /><Button type="submit" variant="secondary" disabled={busy}>{busy ? "Adding…" : "Add member"}</Button></form>}
        </ResourceState>
      </Card></div>
      <div className="project-lower-grid"><Card className="project-panel comments-panel"><div className="section-heading"><div><span className="eyebrow">TEAM DISCUSSION</span><h2>Comments</h2></div></div>
        <ResourceState loading={commentsResource.loading} error={commentsResource.error} reload={commentsResource.reload}><div className="comment-list">{comments.length ? comments.map((item) => <article className="comment" key={item.id}><span className="avatar avatar-small">{item.author?.name?.split(/\s+/).map((part) => part[0]).slice(0, 2).join("")}</span><div className="comment-body"><div className="comment-byline"><strong>{item.author?.name || "Campus member"}</strong><span>{formatDate(item.createdAt)}</span></div><p>{item.content}</p>{(item.authorId === user.id || canManage) && <div className="comment-actions"><Button variant="quiet" onClick={() => { setEditingComment(item); setEditedComment(item.content); }}>Edit</Button><ConfirmButton message="Delete this comment?" onConfirm={() => deleteComment(item)} disabled={busy}>Delete</ConfirmButton></div>}</div></article>) : <EmptyState title="Start the conversation">Share a project update or a question with your team.</EmptyState>}</div>
          <form className="comment-form" onSubmit={postComment}><Field as="textarea" label="Add a comment" name="new-comment" rows={3} maxLength={2000} required placeholder="Write a helpful update…" value={comment} onChange={(event) => setComment(event.target.value)} /><Button type="submit" disabled={busy || !comment.trim()}>{busy ? "Posting…" : "Post comment"}</Button></form>
        </ResourceState>
      </Card>
      <Card className="project-panel documents-panel"><div className="section-heading"><div><span className="eyebrow">PROJECT FILES</span><h2>Documents</h2></div></div><Alert variant="info">Private file storage is not connected yet. This page shows metadata already registered by a configured storage adapter; it does not upload or download files.</Alert>
        <ResourceState loading={documentsResource.loading} error={documentsResource.error} reload={documentsResource.reload}>{(documentsResource.data?.data || []).length ? <div className="document-list">{documentsResource.data.data.map((document) => <div className="document-row" key={document.id}><span className="document-icon">▤</span><span><strong>{document.originalName}</strong><small>{document.contentType} · {(document.sizeBytes / 1024).toFixed(0)} KB · added {formatDate(document.createdAt)}</small></span></div>)}</div> : <p className="muted small">No document metadata has been registered for this project.</p>}</ResourceState>
      </Card></div>
    </>}</ResourceState>
    {projectModal && <Modal title="Edit project" onClose={() => setProjectModal(false)} wide><ProjectForm initial={project} onCancel={() => setProjectModal(false)} onSave={saveProject} busy={busy} /></Modal>}
    {taskModal && <Modal title={taskModal.id ? "Edit task" : "Add a project task"} onClose={() => setTaskModal(null)}><TaskForm initial={taskModal.id ? taskModal : undefined} members={members} onCancel={() => setTaskModal(null)} onSave={saveTask} busy={busy} /></Modal>}
    {editingComment && <Modal title="Edit comment" onClose={() => setEditingComment(null)}><form className="stack-form" onSubmit={saveComment}>
      <Alert>{error}</Alert>
      <Field as="textarea" label="Comment" name="edit-comment" rows={5} maxLength={2000} required value={editedComment} onChange={(event) => setEditedComment(event.target.value)} />
      <div className="form-actions"><Button variant="secondary" onClick={() => setEditingComment(null)}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save comment"}</Button></div>
    </form></Modal>}
  </div>;
}

export function NotificationsPage() {
  const [page, setPage] = useState(1);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const resource = useResource(`/notifications?page=${page}&limit=${PAGE_SIZE}${unreadOnly ? "&unread=true" : ""}`);
  const { run, busy, error } = useAction();
  const notifications = resource.data?.data || [];
  async function markRead(item) { try { await run(`/notifications/${item.id}/read`, { method: "PATCH" }); resource.reload(); } catch {} }
  async function markAllRead() { try { await run("/notifications/read-all", { method: "PATCH" }); resource.reload(); } catch {} }
  return <div className="content-stack"><PageHeader eyebrow="CAMPUS UPDATES" title="Notifications" description="A personal feed of project and task updates sent to your account." action={resource.data?.unreadCount > 0 && <Button variant="secondary" disabled={busy} onClick={markAllRead}>Mark all read</Button>} />
    {error && <Alert>{error}</Alert>}
    <ResourceState loading={resource.loading} error={resource.error} reload={resource.reload}><Card className="toolbar-card"><div className="toolbar"><Field as="select" label="Show notifications" name="notification-filter" value={unreadOnly ? "unread" : "all"} onChange={(event) => { setUnreadOnly(event.target.value === "unread"); setPage(1); }}><option value="all">All notifications</option><option value="unread">Unread only</option></Field><span className="toolbar-count">{resource.data?.unreadCount || 0} unread</span></div></Card>
      <div className="notification-list">{notifications.length ? notifications.map((item) => <Card className={`notification-card ${item.readAt ? "notification-read" : ""}`} key={item.id}><span className={`notification-icon notification-${item.type.toLowerCase()}`}>{item.type === "TASK_ASSIGNED" ? "✓" : item.type === "COMMENT_ADDED" ? "✎" : "◈"}</span><div className="notification-content"><div className="notification-heading"><h2>{item.title}</h2>{!item.readAt && <span className="unread-dot" aria-label="Unread" />}</div><p>{item.message}</p><div className="notification-meta"><span>{item.actor?.name ? `From ${item.actor.name}` : "CampusFlow"}</span><time>{formatDate(item.createdAt)}</time></div></div>{!item.readAt && <Button variant="quiet" disabled={busy} onClick={() => markRead(item)}>Mark read</Button>}</Card>) : <Card><EmptyState title={unreadOnly ? "You’re all caught up" : "No notifications yet"}>{unreadOnly ? "New unread updates will appear here." : "Project assignments and team updates will appear here."}</EmptyState></Card>}</div>
      <Pagination pagination={resource.data?.pagination} onPage={setPage} />
    </ResourceState>
  </div>;
}

export function ProfilePage() {
  const { user, refreshProfile } = useAuth();
  const resource = useResource("/auth/me");
  const profile = resource.data?.data?.user;
  const [saved, setSaved] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [refreshBusy, setRefreshBusy] = useState(false);
  async function refresh() {
    setSaved(false);
    setRefreshError("");
    setRefreshBusy(true);
    try {
      const updated = await refreshProfile();
      resource.setData((current) => current ? { ...current, data: { ...current.data, user: updated } } : { success: true, data: { user: updated } });
      setSaved(true);
    } catch (failure) {
      setRefreshError(failure.message || "Could not refresh your profile.");
    } finally {
      setRefreshBusy(false);
    }
  }
  return <div className="content-stack"><PageHeader eyebrow="ACCOUNT SETTINGS" title="My profile" description="Your current profile comes from the authenticated account in CampusFlow." action={<Button variant="secondary" disabled={refreshBusy} onClick={refresh}>{refreshBusy ? "Refreshing…" : "Refresh profile"}</Button>} />
    {saved && <Alert variant="success">Profile refreshed.</Alert>}{refreshError && <Alert>{refreshError}</Alert>}
    <ResourceState loading={resource.loading} error={resource.error} reload={resource.reload}>{profile && <Card className="profile-card"><span className="avatar avatar-large">{user.name?.split(/\s+/).map((part) => part[0]).slice(0, 2).join("")}</span><div><StatusBadge>{profile.role}</StatusBadge><h2>{profile.name}</h2><p>{profile.email}</p><div className="detail-grid"><span><small>Organization</small><strong>Your campus organization</strong></span><span><small>Account created</small><strong>{formatDate(profile.createdAt)}</strong></span><span><small>Account ID</small><code>{profile.id}</code></span><span><small>Session</small><strong>In-memory bearer session</strong></span></div><div className="profile-security-note"><span>◈</span><p>Your access token is held in this browser tab’s memory. Refreshing the page signs you out. Keep your device and account safe.</p></div></div></Card>}</ResourceState>
  </div>;
}

export function NotFoundPage() {
  const navigate = useNavigate();
  return <div className="not-found"><div className="not-found-code">404</div><h1>That page wandered off.</h1><p>The page may have moved, or you may not have access to it.</p><Button onClick={() => navigate(-1)}>Go back</Button><Link to="/">Return to overview</Link></div>;
}
