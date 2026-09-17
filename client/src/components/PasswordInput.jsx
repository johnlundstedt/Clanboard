import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

// Password field with a show/hide toggle. Works inside the existing `.field`
// wrapper (pass `leftIcon` for the login-card icons) or standalone in admin
// forms. Semantically the type still toggles between password and text.
export default function PasswordInput({ leftIcon, className = "", style, ...inputProps }) {
  const [show, setShow] = useState(false);
  return (
    <div className={`field ${className}`}>
      {leftIcon && <span className="field-icon" style={{ display: "flex" }}>{leftIcon}</span>}
      <input
        {...inputProps}
        type={show ? "text" : "password"}
        style={{ paddingRight: "2.6rem", ...(style || {}) }}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={show ? "Hide password" : "Show password"}
        title={show ? "Hide password" : "Show password"}
        onClick={() => setShow((s) => !s)}
        className="pfield-toggle"
      >
        {show ? <EyeOff size={18} /> : <Eye size={18} />}
      </button>
    </div>
  );
}