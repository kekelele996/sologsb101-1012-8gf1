/**
 * <QualifyTag> 按合格 / 不合格 / 待判定渲染底色与图标。
 * 被台站仪器页（/stations/:id/instruments）与标定记录台（/calibrations）消费。
 */
import { Tag, Tooltip } from 'antd';
import { CheckCircleFilled, CloseCircleFilled, QuestionCircleFilled } from '@ant-design/icons';
import type { ResponseVerdict } from '@/types/calibration';

export interface QualifyTagProps {
  verdict: ResponseVerdict;
  /** 灵敏度值，传入后一并展示 */
  sensitivity?: number;
  /** 自噪值，传入后一并展示 */
  selfNoise?: number;
  size?: 'default' | 'small';
  /** 是否使用浅色描边风格 */
  plain?: boolean;
}

const TONE: Record<ResponseVerdict, { color: string; background: string; border: string; icon: JSX.Element }> = {
  合格: {
    color: '#1e8449',
    background: '#eaf6ee',
    border: '#1e8449',
    icon: <CheckCircleFilled />,
  },
  不合格: {
    color: '#c0392b',
    background: '#fdecea',
    border: '#c0392b',
    icon: <CloseCircleFilled />,
  },
  待判定: {
    color: '#8c8479',
    background: '#f2f2f2',
    border: '#bdbdbd',
    icon: <QuestionCircleFilled />,
  },
};

export function QualifyTag({ verdict, sensitivity, selfNoise, size = 'default', plain = false }: QualifyTagProps) {
  const tone = TONE[verdict] ?? TONE.待判定;
  const detail =
    sensitivity === undefined && selfNoise === undefined
      ? ''
      : `（灵敏度 ${sensitivity ?? '—'} V·s/m，自噪 ${selfNoise ?? '—'}）`;
  const tip = `${verdict}${detail}`;
  return (
    <Tooltip title={tip}>
      <Tag
        icon={tone.icon}
        style={{
          color: plain ? tone.color : '#ffffff',
          background: plain ? tone.background : tone.color,
          borderColor: tone.border,
          fontSize: size === 'small' ? 12 : 13,
          fontWeight: 600,
          borderRadius: 999,
          paddingInline: size === 'small' ? 8 : 10,
          marginInlineEnd: 0,
        }}
      >
        {verdict}
        {sensitivity !== undefined ? (
          <span style={{ fontWeight: 400, marginLeft: 4 }}>
            · {sensitivity} V·s/m
          </span>
        ) : null}
      </Tag>
    </Tooltip>
  );
}

export default QualifyTag;
