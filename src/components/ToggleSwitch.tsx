type Props = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
};

// 滑块开关。用真实 DOM 做轨道和滑块而不是 input 的 ::after 伪元素：
// WebView2 里伪元素的 transform 偶发不生效，之前就出现过勾选了但滑块不动。
export default function ToggleSwitch({ checked, onChange, label }: Props) {
  return (
    <label className="toggle-row">
      <input
        type="checkbox"
        className="toggle-input"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className={`toggle-track ${checked ? "is-on" : ""}`} aria-hidden="true">
        <span className="toggle-thumb" />
      </span>
      <span className="toggle-label">{label}</span>
    </label>
  );
}
