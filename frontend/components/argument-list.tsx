"use client";

import { Button } from "./ui/ui";

export const replaceArgument = (args: readonly string[], index: number, value: string) =>
  args.map((argument, candidate) => candidate === index ? value : argument);

export const removeArgument = (args: readonly string[], index: number) =>
  args.filter((_, candidate) => candidate !== index);

export function ArgumentList({ id, label, args, addLabel, removeLabel, disabled, onChange }: {
  id: string;
  label: string;
  args: readonly string[];
  addLabel: string;
  removeLabel: string;
  disabled?: boolean;
  onChange: (args: string[]) => void;
}) {
  return <div className="field argument-field">
    <span className="argument-label">{label}</span>
    <div className="argument-list">
      {args.map((argument, index) => <div className="argument-row" key={`${id}-${index}`}>
        <input id={`${id}-${index}`} aria-label={`${label} ${index + 1}`} disabled={disabled} value={argument} onChange={(event) => onChange(replaceArgument(args, index, event.target.value))} />
        <Button type="button" size="small" variant="quiet" disabled={disabled} aria-label={`${removeLabel} ${index + 1}`} onClick={() => onChange(removeArgument(args, index))}>−</Button>
      </div>)}
      <Button type="button" size="small" disabled={disabled} onClick={() => onChange([...args, ""])}>{addLabel}</Button>
    </div>
  </div>;
}
