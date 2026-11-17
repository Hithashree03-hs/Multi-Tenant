import { useEffect } from "react";
import { Link } from "react-router-dom";

export function PageHeader({ eyebrow, title, description, action }) {
  return <div className="page-header">
    <div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{description && <p>{description}</p>}</div>
    {action && <div className="page-header-action">{action}</div>}
  </div>;
}

export function Card({ children, className = "", ...props }) {
  return <section className={`card ${className}`.trim()} {...props}>{children}</section>;
}

export function Button({ children, variant = "primary", className = "", type = "button", ...props }) {
  return <button className={`button button-${variant} ${className}`.trim()} type={type} {...props}>{children}</button>;
}

export function Field({ label, hint, className = "", ...props }) {
  const { as, children, ...fieldProps } = props;
  const id = fieldProps.id || fieldProps.name;
  const controlProps = { ...fieldProps, id };
  return <label className={`field ${className}`.trim()} htmlFor={id}>
    <span className="field-label">{label}</span>
    {as === "textarea" ? <textarea {...controlProps}>{children}</textarea> : as === "select" ? <select {...controlProps}>{children}</select> : <input {...controlProps} />}
    {hint && <span className="field-hint">{hint}</span>}
  </label>;
}

export function Alert({ children, variant = "error", onClose }) {
  if (!children) return null;
  return <div className={`alert alert-${variant}`} role={variant === "error" ? "alert" : "status"}>
    <span>{children}</span>{onClose && <button className="alert-close" onClick={onClose} aria-label="Dismiss message">×</button>}
  </div>;
}

export function Loading({ label = "Loading your workspace…" }) {
  return <div className="loading-state" role="status"><span className="spinner" />{label}</div>;
}

export function EmptyState({ title, children, action }) {
  return <div className="empty-state"><div className="empty-icon">✦</div><h3>{title}</h3>{children && <p>{children}</p>}{action}</div>;
}

export function StatusBadge({ children, tone }) {
  const value = String(children || "Unknown");
  const normalized = tone || value.toLowerCase().replace(/[^a-z]+/g, "-");
  return <span className={`badge badge-${normalized}`}>{value.replaceAll("_", " ")}</span>;
}

export function Pagination({ pagination, onPage }) {
  if (!pagination || pagination.totalPages <= 1) return null;
  return <div className="pagination"><span>{pagination.total} total</span><div>
    <Button variant="quiet" disabled={pagination.page <= 1} onClick={() => onPage(pagination.page - 1)}>Previous</Button>
    <span className="page-number">Page {pagination.page} of {pagination.totalPages}</span>
    <Button variant="quiet" disabled={pagination.page >= pagination.totalPages} onClick={() => onPage(pagination.page + 1)}>Next</Button>
  </div></div>;
}

export function Modal({ title, children, onClose, wide = false }) {
  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <header className="modal-header"><h2 id="modal-title">{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close dialog">×</button></header>
      <div className="modal-body">{children}</div>
    </section>
  </div>;
}

export function DataTable({ columns, rows, emptyTitle = "No records yet", emptyMessage = "When data is available, it will appear here." }) {
  if (!rows?.length) return <EmptyState title={emptyTitle}>{emptyMessage}</EmptyState>;
  return <div className="table-wrap"><table><thead><tr>{columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead>
    <tbody>{rows.map((row, index) => <tr key={row.id || index}>{columns.map((column) => <td key={column.key}>{column.render ? column.render(row) : row[column.key]}</td>)}</tr>)}</tbody>
  </table></div>;
}

export function LinkButton({ to, children }) {
  return <Link className="button button-secondary" to={to}>{children}</Link>;
}

export function ConfirmButton({ children = "Delete", message = "Delete this item? This action cannot be undone.", onConfirm, disabled }) {
  return <Button variant="danger" disabled={disabled} onClick={() => { if (window.confirm(message)) onConfirm(); }}>{children}</Button>;
}

export function formatDate(value, options = {}) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", ...options }).format(date);
}

export function initials(name = "CampusFlow") {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
}
