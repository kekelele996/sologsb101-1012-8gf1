/**
 * 出车批次与对账（计量站侧）：按出车批次记录出车日期、能带台数与逐台结论；
 * 逐台结论按 台站码 + 序列号 与运维班送检登记对账，对上了才写回仪器（Calibration），
 * 对不上挂起等确认、不写结论；退回只退该台，其余照旧入库。
 * 已对账结论与历史切批为只读区。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  Tooltip,
  Typography,
} from 'antd';
import {
  CheckCircleOutlined,
  DeleteOutlined,
  PlusOutlined,
  ReloadOutlined,
  RollbackOutlined,
  SendOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import StatBadge from '@/components/common/StatBadge';
import QualifyTag from '@/components/common/QualifyTag';
import EmptyPanel from '@/components/common/EmptyPanel';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectStations } from '@/stores/arraySlice';
import { selectInstruments } from '@/stores/instrumentSlice';
import { selectCalibrations } from '@/stores/calibrationSlice';
import {
  addBatchItem,
  completeBatch,
  createBatch,
  dispatchBatch,
  reconcileItems,
  removeBatch,
  returnItem,
  saveItemConclusion,
  selectBatchItems,
  selectBatchStats,
  selectBatches,
} from '@/stores/dispatchSlice';
import { selectSubmissions, selectSubmissionStatusCounts } from '@/stores/submissionSlice';
import {
  batchItemStatusColor,
  batchStatusColor,
  createEmptyBatchDraft,
  type BatchDraft,
  type BatchItem,
  type DispatchBatch,
} from '@/types/dispatch';
import {
  RESPONSE_VERDICTS,
  SENSITIVITY_RANGE,
  SELF_NOISE_LIMIT,
  judgeCalibration,
  type ResponseVerdict,
} from '@/types/calibration';
import { findLegacyOrphans, isConclusionFilled } from '@/utils/reconcile';
import { round } from '@/utils/geo';
import { initDatabase, sliceLegacyBatches } from '@/utils/db';

interface BatchFormValues {
  dispatchDate: dayjs.Dayjs | null;
  capacity: number;
  agency: string;
  routeNote: string;
  remark: string;
}

interface ItemDraft {
  sensitivity: number;
  selfNoise: number;
  responseVerdict: ResponseVerdict;
  operator: string;
}

export default function CalibrationBoard() {
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();

  const batches = useAppSelector(selectBatches);
  const items = useAppSelector(selectBatchItems);
  const submissions = useAppSelector(selectSubmissions);
  const instruments = useAppSelector(selectInstruments);
  const stations = useAppSelector(selectStations);
  const calibrations = useAppSelector(selectCalibrations);
  const batchStats = useAppSelector(selectBatchStats);
  const subCounts = useAppSelector(selectSubmissionStatusCounts);

  const [batchModalOpen, setBatchModalOpen] = useState(false);
  const [detailBatchId, setDetailBatchId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [batchForm] = Form.useForm<BatchFormValues>();
  const [addItemForm] = Form.useForm<{ stationCode: string; serialNo: string }>();
  /** 明细录入草稿（避免直接改 Redux state） */
  const [drafts, setDrafts] = useState<Record<string, ItemDraft>>({});

  useEffect(() => {
    if (batches.length === 0 && submissions.length === 0) void initDatabase();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------------ 派生索引 ------------------------------ */

  const instrumentById = useMemo(() => {
    const map = new Map<string, (typeof instruments)[number]>();
    instruments.forEach((row) => map.set(row.id, row));
    return map;
  }, [instruments]);

  const stationById = useMemo(() => {
    const map = new Map<string, (typeof stations)[number]>();
    stations.forEach((row) => map.set(row.id, row));
    return map;
  }, [stations]);

  const instrumentBySerial = useMemo(() => {
    const map = new Map<string, (typeof instruments)[number]>();
    instruments.forEach((row) => map.set(row.serialNo.trim(), row));
    return map;
  }, [instruments]);

  const detailBatch = useMemo(
    () => batches.find((row) => row.id === detailBatchId) ?? null,
    [batches, detailBatchId]
  );

  const detailItems = useMemo(
    () => items.filter((row) => row.batchId === detailBatchId).sort((a, b) => a.createdAt - b.createdAt),
    [items, detailBatchId]
  );

  const failedItems = useMemo(() => items.filter((row) => row.reconStatus === '对账失败'), [items]);
  const returnedItems = useMemo(() => items.filter((row) => row.reconStatus === '已退回'), [items]);

  const orphans = useMemo(
    () => findLegacyOrphans(calibrations, items, instruments, stations),
    [calibrations, items, instruments, stations]
  );

  const failedTimeline = useMemo(
    () =>
      failedItems.map((item) => ({
        color: 'red' as const,
        children: (
          <div key={item.id}>
            <div>
              <span className="gb-mono">
                {item.stationCode} / {item.serialNo}
              </span>
              <Tag color="red" style={{ marginLeft: 8 }}>
                挂起
              </Tag>
            </div>
            <div className="gb-hint">{item.reconNote}</div>
          </div>
        ),
      })),
    [failedItems]
  );

  const returnedTimeline = useMemo(
    () =>
      returnedItems.map((item) => ({
        color: 'gray' as const,
        children: (
          <div key={item.id}>
            <span className="gb-mono">
              {item.stationCode} / {item.serialNo}
            </span>
            <Tag style={{ marginLeft: 8 }}>已退回</Tag>
            <div className="gb-hint">{item.reconNote}</div>
          </div>
        ),
      })),
    [returnedItems]
  );

  const reconciledRows = useMemo(() => {
    return calibrations
      .map((row) => {
        const instrument = instrumentById.get(row.instrumentId);
        const station = instrument ? stationById.get(instrument.stationId) : undefined;
        return {
          row,
          instrumentModel: instrument?.model ?? '仪器已删除',
          serialNo: instrument?.serialNo ?? '—',
          stationCode: station?.code ?? '—',
        };
      })
      .sort((a, b) => b.row.date.localeCompare(a.row.date));
  }, [calibrations, instrumentById, stationById]);

  /* ------------------------------ 草稿 ------------------------------ */

  const getDraft = (item: BatchItem): ItemDraft =>
    drafts[item.id] ?? {
      sensitivity: item.sensitivity || 0,
      selfNoise: item.selfNoise || 0,
      responseVerdict: item.responseVerdict,
      operator: item.operator || '',
    };

  const updateDraft = (itemId: string, patch: Partial<ItemDraft>) => {
    setDrafts((prev) => {
      const item = items.find((row) => row.id === itemId);
      const base =
        prev[itemId] ??
        ({
          sensitivity: item?.sensitivity || 0,
          selfNoise: item?.selfNoise || 0,
          responseVerdict: item?.responseVerdict ?? '待判定',
          operator: item?.operator || '',
        } as ItemDraft);
      return { ...prev, [itemId]: { ...base, ...patch } };
    });
  };

  /* ------------------------------ 批次动作 ------------------------------ */

  const openBatchCreate = () => {
    batchForm.setFieldsValue({
      dispatchDate: dayjs(),
      capacity: 4,
      agency: '省地震局计量站',
      routeNote: '',
      remark: '',
    });
    setBatchModalOpen(true);
  };

  const submitBatch = async () => {
    const values = await batchForm.validateFields();
    setSubmitting(true);
    try {
      const draft: BatchDraft = {
        ...createEmptyBatchDraft(),
        dispatchDate: values.dispatchDate ? values.dispatchDate.format('YYYY-MM-DD') : '',
        capacity: Number(values.capacity),
        agency: values.agency?.trim() ?? '',
        routeNote: values.routeNote?.trim() ?? '',
        remark: values.remark?.trim() ?? '',
      };
      const result = await dispatch(createBatch(draft)).unwrap();
      message.success(`批次 ${result.batch.batchNo} 已建，拉入 ${result.assigned} 台，其余排队`);
      setBatchModalOpen(false);
    } catch (error) {
      message.error(typeof error === 'string' ? error : '批次创建失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDispatch = async (batch: DispatchBatch) => {
    try {
      await dispatch(dispatchBatch(batch.id)).unwrap();
      message.success(`批次 ${batch.batchNo} 已出车，本批仪器锁定`);
    } catch (error) {
      message.error(typeof error === 'string' ? error : '出车失败');
    }
  };

  const handleComplete = async (batch: DispatchBatch) => {
    try {
      await dispatch(completeBatch(batch.id)).unwrap();
      message.success(`批次 ${batch.batchNo} 已完成`);
    } catch (error) {
      message.error(typeof error === 'string' ? error : '完成失败');
    }
  };

  const handleReconcileAll = async () => {
    const result = await dispatch(reconcileItems({})).unwrap();
    message.success(`对账完成：${result.reconciled} 台对上，${result.failed} 台挂起`);
  };

  const handleRetryFromOps = async () => {
    const result = await dispatch(reconcileItems({})).unwrap();
    message.success(`按运维班送检记录重试：${result.reconciled} 台对上，${result.failed} 台仍挂起`);
  };

  const handleReslice = async () => {
    const result = await sliceLegacyBatches();
    message.success(`已切出 ${result.slicedBatches} 个批次、${result.slicedItems} 台；${result.orphans} 台切不出来`);
  };

  const handleAddItem = async () => {
    if (!detailBatch) return;
    const values = await addItemForm.validateFields();
    try {
      await dispatch(
        addBatchItem({
          batchId: detailBatch.id,
          stationCode: values.stationCode.trim(),
          serialNo: values.serialNo.trim(),
        })
      ).unwrap();
      addItemForm.resetFields();
      message.success('已追加逐台明细');
    } catch (error) {
      message.error(typeof error === 'string' ? error : '追加失败');
    }
  };

  const handleSaveConclusion = async (item: BatchItem) => {
    const draft = getDraft(item);
    try {
      await dispatch(
        saveItemConclusion({
          itemId: item.id,
          patch: {
            sensitivity: draft.sensitivity,
            selfNoise: draft.selfNoise,
            responseVerdict: draft.responseVerdict,
            operator: draft.operator.trim(),
            remark: item.remark?.trim() ?? '',
          },
        })
      ).unwrap();
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
      message.success('结论已保存并完成对账');
    } catch (error) {
      message.error(typeof error === 'string' ? error : '保存失败');
    }
  };

  const handleReturn = async (item: BatchItem) => {
    try {
      await dispatch(returnItem({ itemId: item.id, reason: '计量站退回' })).unwrap();
      message.success('该台已退回，其余仪器照旧入库');
    } catch (error) {
      message.error(typeof error === 'string' ? error : '退回失败');
    }
  };

  const totals = useMemo(
    () => ({
      batches: batches.length,
      preparing: batches.filter((b) => b.status === '筹备中').length,
      dispatched: batches.filter((b) => b.status === '已出车').length,
      items: items.length,
      reconciled: items.filter((i) => i.reconStatus === '已对账').length,
      failed: failedItems.length,
      returned: returnedItems.length,
      queued: subCounts.待安排,
    }),
    [batches, items, failedItems, returnedItems, subCounts]
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <Typography.Title level={4} style={{ margin: '0 0 4px', color: '#1e3a5f' }}>
            出车批次与对账（计量站）
          </Typography.Title>
          <p className="gb-hint">
            按出车批次记录出车日期、能带台数与逐台结论；逐台结论按
            <b> 台站码 + 序列号 </b>
            与运维班送检登记对账，对上了才写回仪器，对不上挂起等确认、不写结论。批次名额满了排队等下一趟，已出车的照旧不动。
          </p>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={() => void handleReslice()}>
            重切历史批次
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openBatchCreate}>
            新建出车批次
          </Button>
        </Space>
      </div>

      <div className="gb-stats-row">
        <StatBadge label="筹备中批次" value={totals.preparing} suffix="个" tone="info" />
        <StatBadge label="已出车" value={totals.dispatched} suffix="个" tone="primary" />
        <StatBadge label="排队送检" value={totals.queued} suffix="台" tone="warning" />
        <StatBadge label="已对账" value={totals.reconciled} suffix="台" tone="success" />
        <StatBadge
          label="挂起待确认"
          value={totals.failed}
          suffix="台"
          tone={totals.failed > 0 ? 'danger' : 'success'}
        />
        <StatBadge label="已退回" value={totals.returned} suffix="台" tone="default" />
      </div>

      {failedItems.length > 0 ? (
        <Alert
          type="error"
          showIcon
          message={`${failedItems.length} 台逐台结论与运维班送检登记对不上，已挂起、未写结论`}
          description={
            <Space direction="vertical" size={4}>
              <span>
                {failedItems
                  .slice(0, 5)
                  .map((item) => `${item.stationCode} / ${item.serialNo}：${item.reconNote}`)
                  .join('；')}
              </span>
              <span>
                请运维班补登记或核对台站码 / 序列号后，
                <Button type="link" size="small" onClick={() => void handleRetryFromOps()}>
                  按运维班这侧重试
                </Button>
                。
              </span>
            </Space>
          }
        />
      ) : null}

      {/* 批次表 */}
      <Card className="gb-panel" size="small" title={`出车批次（${totals.batches} 个）`}>
        {batches.length === 0 ? (
          <EmptyPanel
            title="还没有出车批次"
            description="新建出车批次（填出车日期与能带台数），运维班送检登记会按 FIFO 排队进入筹备中的批次。"
            actionText="新建出车批次"
            onAction={openBatchCreate}
          />
        ) : (
          <Table
            rowKey="id"
            size="small"
            className="gb-table-compact"
            dataSource={batches}
            pagination={false}
            columns={[
              { title: '批次号', dataIndex: 'batchNo', width: 170, className: 'gb-mono' },
              { title: '出车日期', dataIndex: 'dispatchDate', width: 120, className: 'gb-mono' },
              { title: '计量机构', dataIndex: 'agency', ellipsis: true },
              {
                title: '名额（已用 / 能带）',
                width: 150,
                render: (_: unknown, batch: DispatchBatch) => {
                  const stats = batchStats[batch.id];
                  const used = stats?.used ?? 0;
                  const full = used >= batch.capacity;
                  return (
                    <span className="gb-mono">
                      <span className={full ? 'gb-danger' : ''}>{used}</span> / {batch.capacity}
                      {full ? (
                        <Tag color="red" style={{ marginLeft: 6 }}>
                          满员
                        </Tag>
                      ) : null}
                    </span>
                  );
                },
              },
              {
                title: '逐台进度',
                width: 210,
                render: (_: unknown, batch: DispatchBatch) => {
                  const stats = batchStats[batch.id];
                  if (!stats) return <span className="gb-hint">—</span>;
                  return (
                    <Space size={6} wrap>
                      <Tag color="green">已对账 {stats.reconciled}</Tag>
                      <Tag color="red">挂起 {stats.failed}</Tag>
                      <Tag>退回 {stats.returned}</Tag>
                    </Space>
                  );
                },
              },
              {
                title: '状态',
                width: 100,
                render: (_: unknown, batch: DispatchBatch) => (
                  <Tag color={batchStatusColor(batch.status)}>{batch.status}</Tag>
                ),
              },
              {
                title: '操作',
                width: 300,
                render: (_: unknown, batch: DispatchBatch) => (
                  <Space size={6} wrap>
                    <Button size="small" type="primary" onClick={() => setDetailBatchId(batch.id)}>
                      逐台明细
                    </Button>
                    {batch.status === '筹备中' ? (
                      <Button size="small" icon={<SendOutlined />} onClick={() => void handleDispatch(batch)}>
                        出车
                      </Button>
                    ) : null}
                    {batch.status === '已出车' ? (
                      <Button size="small" icon={<CheckCircleOutlined />} onClick={() => void handleComplete(batch)}>
                        完成
                      </Button>
                    ) : null}
                    {batch.status !== '已出车' ? (
                      <Popconfirm
                        title="删除批次"
                        description="将清空本批逐台明细，已安排的送检登记回退为待安排（排队等下一趟）。确认删除？"
                        okText="删除"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                        onConfirm={() =>
                          void dispatch(removeBatch(batch.id))
                            .unwrap()
                            .then(() => message.success('批次已删除'))
                        }
                      >
                        <Button size="small" danger icon={<DeleteOutlined />}>
                          删除
                        </Button>
                      </Popconfirm>
                    ) : null}
                  </Space>
                ),
              },
            ]}
          />
        )}
      </Card>

      {/* 挂起 + 退回 */}
      <Row gutter={[14, 14]}>
        <Col xs={24} lg={12}>
          <Card
            className="gb-panel"
            size="small"
            title={`挂起待确认（${failedItems.length} 台）`}
            extra={
              <Button size="small" onClick={() => void handleRetryFromOps()}>
                按运维班重试
              </Button>
            }
          >
            {failedItems.length === 0 ? (
              <EmptyPanel title="没有挂起明细" description="所有逐台结论都已与运维班送检登记对上。" compact />
            ) : (
              <Timeline items={failedTimeline} />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card className="gb-panel" size="small" title={`已退回（${returnedItems.length} 台）`}>
            {returnedItems.length === 0 ? (
              <EmptyPanel title="没有退回记录" description="计量站退回某台时只退这一台，其余照旧入库。" compact />
            ) : (
              <Timeline items={returnedTimeline} />
            )}
          </Card>
        </Col>
      </Row>

      {/* 历史切不出来的标定 */}
      {orphans.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={`有 ${orphans.length} 条旧标定切不出出车批次`}
          description={
            <div>
              <div>
                旧数据按「标定日期 + 机构」切批次时，以下标定缺日期 / 缺机构 / 找不到对应仪器台站，单列如下，请人工补录后重切：
              </div>
              <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                {orphans.slice(0, 8).map((cal) => {
                  const instrument = instrumentById.get(cal.instrumentId);
                  return (
                    <li key={cal.id} className="gb-mono">
                      {cal.date || '无日期'} · {cal.agency || '无机构'} · 序列号 {instrument?.serialNo ?? '未知'} ·{' '}
                      {cal.sensitivity} / {cal.selfNoise}
                    </li>
                  );
                })}
              </ul>
              <Button size="small" onClick={() => void handleReslice()}>
                补录后重切
              </Button>
            </div>
          }
        />
      ) : null}

      {/* 已对账结论（只读） */}
      <Card className="gb-panel" size="small" title={`已对账标定结论（${reconciledRows.length} 条）`}>
        {reconciledRows.length === 0 ? (
          <EmptyPanel
            title="还没有已对账结论"
            description="逐台结论与运维班送检登记对账成功后，结论会写回仪器并显示在这里。"
            compact
          />
        ) : (
          <Table
            rowKey={(item) => item.row.id}
            size="small"
            className="gb-table-compact"
            dataSource={reconciledRows}
            pagination={{ pageSize: 8, showSizeChanger: false }}
            columns={[
              { title: '标定日期', dataIndex: ['row', 'date'], width: 120, className: 'gb-mono' },
              {
                title: '仪器',
                render: (_: unknown, item) => (
                  <div>
                    <div>{item.instrumentModel}</div>
                    <div className="gb-hint gb-mono">{item.serialNo}</div>
                  </div>
                ),
              },
              { title: '台站码', dataIndex: ['stationCode'], width: 110, className: 'gb-mono' },
              { title: '灵敏度', dataIndex: ['row', 'sensitivity'], width: 110, align: 'right', className: 'gb-mono' },
              { title: '自噪', dataIndex: ['row', 'selfNoise'], width: 90, align: 'right', className: 'gb-mono' },
              {
                title: '结论',
                width: 170,
                render: (_: unknown, item) => (
                  <QualifyTag
                    verdict={item.row.responseVerdict}
                    sensitivity={round(item.row.sensitivity, 2)}
                    size="small"
                  />
                ),
              },
              { title: '标定人', dataIndex: ['row', 'operator'], width: 100 },
              { title: '机构', dataIndex: ['row', 'agency'], ellipsis: true },
            ]}
          />
        )}
      </Card>

      {/* 新建批次弹窗 */}
      <Modal
        open={batchModalOpen}
        title="新建出车批次"
        onCancel={() => setBatchModalOpen(false)}
        onOk={() => void submitBatch()}
        confirmLoading={submitting}
        okText="建批并拉取送检"
        destroyOnClose
      >
        <Form form={batchForm} layout="vertical" preserve={false}>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="dispatchDate" label="出车日期" rules={[{ required: true, message: '请选择出车日期' }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="capacity" label="能带台数" rules={[{ required: true, message: '请填写能带台数' }]}>
                <InputNumber min={1} max={200} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="agency" label="计量机构" rules={[{ required: true, message: '请填写计量机构' }]}>
            <Input maxLength={40} placeholder="如：省地震局计量站" />
          </Form.Item>
          <Form.Item name="routeNote" label="出车路线 / 前往台阵">
            <Input maxLength={80} placeholder="如：龙门峡流动台阵" />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={80} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 批次逐台明细抽屉 */}
      <Drawer
        open={!!detailBatch}
        title={detailBatch ? `${detailBatch.batchNo} · 逐台明细` : ''}
        onClose={() => setDetailBatchId(null)}
        width={960}
        extra={
          detailBatch ? (
            <Space>
              <Button size="small" onClick={() => void handleReconcileAll()}>
                全部对账
              </Button>
              {detailBatch.status === '筹备中' ? (
                <Button type="primary" icon={<SendOutlined />} onClick={() => void handleDispatch(detailBatch)}>
                  出车
                </Button>
              ) : null}
              {detailBatch.status === '已出车' ? (
                <Button icon={<CheckCircleOutlined />} onClick={() => void handleComplete(detailBatch)}>
                  完成批次
                </Button>
              ) : null}
            </Space>
          ) : null
        }
      >
        {detailBatch ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Descriptions size="small" column={3} bordered>
              <Descriptions.Item label="出车日期">{detailBatch.dispatchDate}</Descriptions.Item>
              <Descriptions.Item label="计量机构">{detailBatch.agency}</Descriptions.Item>
              <Descriptions.Item label="状态">
                <Tag color={batchStatusColor(detailBatch.status)}>{detailBatch.status}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="能带台数">{detailBatch.capacity} 台</Descriptions.Item>
              <Descriptions.Item label="已用名额">{batchStats[detailBatch.id]?.used ?? 0} 台</Descriptions.Item>
              <Descriptions.Item label="路线">{detailBatch.routeNote || '—'}</Descriptions.Item>
            </Descriptions>

            {detailBatch.status === '筹备中' ? (
              <Card size="small" title="追加逐台（散台登记）">
                <Space wrap>
                  <Form form={addItemForm} layout="inline">
                    <Form.Item name="stationCode" rules={[{ required: true, message: '台站码' }]}>
                      <Input placeholder="台站码" style={{ width: 140 }} />
                    </Form.Item>
                    <Form.Item name="serialNo" rules={[{ required: true, message: '序列号' }]}>
                      <Input placeholder="序列号" style={{ width: 200 }} />
                    </Form.Item>
                    <Button type="primary" icon={<PlusOutlined />} onClick={() => void handleAddItem()}>
                      添加
                    </Button>
                  </Form>
                </Space>
                <div className="gb-hint">
                  散台只记台站码 + 序列号；对账对不上会挂起，等运维班补登记后按运维侧重试。
                </div>
              </Card>
            ) : null}

            <Table
              rowKey="id"
              size="small"
              className="gb-table-compact"
              dataSource={detailItems}
              pagination={false}
              locale={{
                emptyText: (
                  <EmptyPanel
                    title="本批还没有明细"
                    description="建批后自动拉入排队的送检登记，或在上方追加散台。"
                    compact
                  />
                ),
              }}
              columns={[
                {
                  title: '台站码',
                  width: 100,
                  render: (_: unknown, item: BatchItem) => <span className="gb-mono">{item.stationCode}</span>,
                },
                {
                  title: '序列号',
                  width: 160,
                  render: (_: unknown, item: BatchItem) => <span className="gb-mono">{item.serialNo}</span>,
                },
                {
                  title: '型号',
                  width: 130,
                  render: (_: unknown, item: BatchItem) => {
                    const inst = item.instrumentId
                      ? instrumentById.get(item.instrumentId)
                      : instrumentBySerial.get(item.serialNo.trim());
                    return inst?.model ?? <span className="gb-hint">未匹配</span>;
                  },
                },
                {
                  title: '灵敏度',
                  width: 120,
                  render: (_: unknown, item: BatchItem) => {
                    const draft = getDraft(item);
                    const locked = item.reconStatus === '已退回' || item.reconStatus === '已对账';
                    return (
                      <InputNumber
                        size="small"
                        min={0}
                        max={100000}
                        step={0.01}
                        style={{ width: '100%' }}
                        value={draft.sensitivity || undefined}
                        disabled={locked}
                        onChange={(v) => updateDraft(item.id, { sensitivity: Number(v) || 0 })}
                      />
                    );
                  },
                },
                {
                  title: '自噪',
                  width: 100,
                  render: (_: unknown, item: BatchItem) => {
                    const draft = getDraft(item);
                    const locked = item.reconStatus === '已退回' || item.reconStatus === '已对账';
                    return (
                      <InputNumber
                        size="small"
                        min={0}
                        max={100}
                        step={0.01}
                        style={{ width: '100%' }}
                        value={draft.selfNoise || undefined}
                        disabled={locked}
                        onChange={(v) => updateDraft(item.id, { selfNoise: Number(v) || 0 })}
                      />
                    );
                  },
                },
                {
                  title: '结论',
                  width: 130,
                  render: (_: unknown, item: BatchItem) => {
                    const draft = getDraft(item);
                    const locked = item.reconStatus === '已退回' || item.reconStatus === '已对账';
                    const inst = item.instrumentId
                      ? instrumentById.get(item.instrumentId)
                      : instrumentBySerial.get(item.serialNo.trim());
                    return (
                      <Space size={4}>
                        <Select
                          size="small"
                          style={{ width: 90 }}
                          value={draft.responseVerdict}
                          disabled={locked}
                          options={RESPONSE_VERDICTS.map((v) => ({ label: v, value: v }))}
                          onChange={(v) => updateDraft(item.id, { responseVerdict: v as ResponseVerdict })}
                        />
                        {inst ? (
                          <Button
                            size="small"
                            type="text"
                            title="按灵敏度与自噪自动初判"
                            onClick={() =>
                              updateDraft(item.id, {
                                responseVerdict: judgeCalibration(inst.type, draft.sensitivity, draft.selfNoise),
                              })
                            }
                          >
                            初判
                          </Button>
                        ) : null}
                      </Space>
                    );
                  },
                },
                {
                  title: '对账状态',
                  width: 100,
                  render: (_: unknown, item: BatchItem) => (
                    <Tooltip title={item.reconNote || ''}>
                      <Tag color={batchItemStatusColor(item.reconStatus)}>{item.reconStatus}</Tag>
                    </Tooltip>
                  ),
                },
                {
                  title: '操作',
                  width: 190,
                  render: (_: unknown, item: BatchItem) => {
                    const draft = getDraft(item);
                    const locked = item.reconStatus === '已退回' || item.reconStatus === '已对账';
                    return (
                      <Space size={4} wrap>
                        {!locked ? (
                          <Button
                            size="small"
                            type="primary"
                            disabled={!isConclusionFilled({ ...item, sensitivity: draft.sensitivity })}
                            onClick={() => void handleSaveConclusion(item)}
                          >
                            保存并对账
                          </Button>
                        ) : null}
                        {item.reconStatus === '待对账' || item.reconStatus === '对账失败' ? (
                          <Popconfirm
                            title="退回该台"
                            description="只退这一台，其余仪器照旧入库。确认退回？"
                            okText="退回"
                            cancelText="取消"
                            onConfirm={() => void handleReturn(item)}
                          >
                            <Button size="small" icon={<RollbackOutlined />}>
                              退回
                            </Button>
                          </Popconfirm>
                        ) : null}
                      </Space>
                    );
                  },
                },
              ]}
            />
            <div className="gb-hint">
              灵敏度区间：宽频带 {SENSITIVITY_RANGE.宽频带.min}~{SENSITIVITY_RANGE.宽频带.max}、短周期{' '}
              {SENSITIVITY_RANGE.短周期.min}~{SENSITIVITY_RANGE.短周期.max}、强震 {SENSITIVITY_RANGE.强震.min}~
              {SENSITIVITY_RANGE.强震.max}；自噪限值 {SELF_NOISE_LIMIT}。保存后按台站码+序列号对账，对上写结论，对不上挂起。
            </div>
          </Space>
        ) : null}
      </Drawer>
    </div>
  );
}
