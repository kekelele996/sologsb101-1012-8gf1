/**
 * <EmptyPanel> 空数据引导与新建入口。
 * 被全部列表页消费；列表为空、筛选无结果、层级路由 id 不存在时统一使用。
 */
import { Button, Empty, Space, Typography } from 'antd';
import type { ReactNode } from 'react';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';

export interface EmptyPanelProps {
  title?: string;
  description?: ReactNode;
  /** 主按钮文案，为空则不渲染 */
  actionText?: string;
  onAction?: () => void;
  /** 次要按钮文案 */
  secondaryText?: string;
  onSecondary?: () => void;
  compact?: boolean;
  extra?: ReactNode;
}

export function EmptyPanel({
  title = '暂无数据',
  description = '当前筛选条件下没有记录，可调整条件或新建一条。',
  actionText = '',
  onAction,
  secondaryText = '',
  onSecondary,
  compact = false,
  extra,
}: EmptyPanelProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        padding: compact ? '24px 16px' : '44px 24px',
        background: '#f7fafc',
        border: '1px dashed #b9c6d4',
        borderRadius: 12,
        textAlign: 'center',
      }}
    >
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        imageStyle={{ height: compact ? 44 : 60 }}
        description={
          <Space direction="vertical" size={4}>
            <Typography.Text strong style={{ fontSize: 16 }}>
              {title}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              {description}
            </Typography.Text>
          </Space>
        }
      >
        {actionText || secondaryText ? (
          <Space wrap>
            {actionText && onAction ? (
              <Button type="primary" icon={<PlusOutlined />} onClick={onAction}>
                {actionText}
              </Button>
            ) : null}
            {secondaryText && onSecondary ? (
              <Button icon={<ReloadOutlined />} onClick={onSecondary}>
                {secondaryText}
              </Button>
            ) : null}
          </Space>
        ) : null}
      </Empty>
      {extra ? <div style={{ marginTop: 8 }}>{extra}</div> : null}
    </div>
  );
}

export default EmptyPanel;
