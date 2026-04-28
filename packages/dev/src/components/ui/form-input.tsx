const inputClassName = "w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-400 focus:outline-none";

export function FormInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className, ...rest } = props;
  return <input className={className ? `${inputClassName} ${className}` : inputClassName} {...rest} />;
}

export function FormTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className, ...rest } = props;
  return <textarea className={className ? `${inputClassName} resize-none ${className}` : `${inputClassName} resize-none`} {...rest} />;
}

export function FormSelect({ className, children, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={className ? `${inputClassName} ${className}` : inputClassName} {...rest}>
      {children}
    </select>
  );
}

interface FormCheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: string;
}

export function FormCheckbox({ label, className, id, ...rest }: FormCheckboxProps) {
  return (
    <label htmlFor={id} className="flex items-center gap-2">
      <input type="checkbox" id={id} className={`h-4 w-4 rounded border-gray-300 ${className ?? ""}`} {...rest} />
      {label && <span className="text-sm font-medium text-gray-700">{label}</span>}
    </label>
  );
}

interface FormLabelProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
  hint?: React.ReactNode;
}

export function FormLabel({ hint, className, children, ...rest }: FormLabelProps) {
  return (
    <label className={`mb-1 block text-sm font-medium text-gray-700 ${className ?? ""}`} {...rest}>
      {children}
      {hint && <span className="ml-1 text-xs font-normal text-gray-400">{hint}</span>}
    </label>
  );
}
