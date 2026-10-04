/**
 * <StatBadge> 计数与占比徽标。
 * 被台站仪器页（/stations/:id/instruments）、更换提醒页（/replacements）与几何页（/geometry）消费。
 */
import { Progress, Tooltip } from 'antd';

export type StatTone = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

export interface StatBadgeProps {
  label: string;
  value: number | string;
  suffix?: string;
  /** 占比（0-100），传入后渲染进度条 */
  percent?: number;
  tone?: StatTone;
  size?: 'default' | 'small';
  /** 悬停提示 */
  tip?: string;
}

const TONE_COLOR: Record<StatTone, string> = {
  default: '#5b6b78',
  primary: '#1e3a5f',
  success: '#1e8449',
  warning: '#d68910',
  danger: '#c0392b',
  info: '#3f7bbf',
};

export function StatBadge({
  label,
  value,
  suffix = '',
  percent,
  tone = 'primary',
  size = 'default',
  tip,
}: StatBadgeProps) {
  const color = TONE_COLOR[tone] ?? TONE_COLOR.primary;
  const body = (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minWidth: size === 'small' ? 104 : 132,
        padding: size === 'small' ? '8px 10px' : '12px 14px',
        background: '#ffffff',
        border: '1px solid #dbe4ee',
        borderLeft: `4px solid ${color}`,
        borderRadius: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#5b6b78' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block' }} />
        <span>{label}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
        <span
          style={{
            fontSize: size === 'small' ? 18 : 22,
            fontWeight: 700,
            color: '#16232e',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {percent !== undefined ? `${percent}%` : value}
        </span>
        {suffix ? <span style={{ fontSize: 12, color: '#8194a2' }}>{suffix}</span> : null}
      </div>
      {percent !== undefined ? (
        <Progress percent={Math.min(100, Math.max(0, percent))} size="small" showInfo={false} strokeColor={color} />
      ) : null}
    </div>
  );

  return tip ? <Tooltip title={tip}>{body}</Tooltip> : body;
}

export default StatBadge;
