/**
 * <RouteMissingPanel> 层级路由友好空态。
 * 直接深链访问 /stations/:id/instruments 时，若 IndexedDB 中查不到该台站，
 * 统一渲染本组件（而不是白屏），并提供返回入口与可用 id 快捷跳转。
 */
import { Button, Space, Tag, Typography } from 'antd';
import { ArrowLeftOutlined, ExclamationCircleFilled, LinkOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';

export interface RouteMissingPanelProps {
  /** 缺什么就说什么，如「台阵」「台站」 */
  entityLabel: string;
  missingId?: string;
  fallbackPath: string;
  fallbackText?: string;
  candidates?: Array<{ id: string; label: string; path: string }>;
}

export function RouteMissingPanel({
  entityLabel,
  missingId = '',
  fallbackPath,
  fallbackText = '返回列表',
  candidates = [],
}: RouteMissingPanelProps) {
  const navigate = useNavigate();
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        padding: '48px 24px',
        background: '#fff9f0',
        border: '1px dashed #e0b070',
        borderRadius: 12,
        textAlign: 'center',
      }}
    >
      <ExclamationCircleFilled style={{ fontSize: 34, color: '#d68910' }} />
      <Typography.Title level={5} style={{ margin: 0, color: '#7a4a06' }}>
        未找到对应的{entityLabel}
      </Typography.Title>
      <Typography.Paragraph style={{ maxWidth: 640, margin: 0, fontSize: 13, color: '#8a6a3a' }}>
        {missingId ? (
          <>
            {entityLabel}（id: <Tag>{missingId}</Tag>）在本地 IndexedDB 中不存在。
          </>
        ) : (
          <>{entityLabel}在本地 IndexedDB 中不存在。</>
        )}
        可能该记录已被删除，或链接来自其他浏览器的本地数据（本应用的数据只保存在当前浏览器 IndexedDB）。
      </Typography.Paragraph>
      <Space wrap style={{ marginTop: 10 }}>
        <Button type="primary" icon={<ArrowLeftOutlined />} onClick={() => navigate(fallbackPath)}>
          {fallbackText}
        </Button>
        {candidates.map((candidate) => (
          <Button key={candidate.id} icon={<LinkOutlined />} onClick={() => navigate(candidate.path)}>
            {candidate.label}
          </Button>
        ))}
      </Space>
    </div>
  );
}

export default RouteMissingPanel;
