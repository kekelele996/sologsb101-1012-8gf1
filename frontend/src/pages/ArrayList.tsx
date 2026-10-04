/**
 * 模块 1：/arrays 台阵与台站台账
 * 新建台阵、按布设日期与运行状态筛选；台站数与孔径自动汇总回显。
 * 复用 <FilterBar>、<EmptyPanel>。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  App as AntdApp,
  Button,
  Card,
  Col,
  DatePicker,
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
  Typography,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, RightOutlined, SyncOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import FilterBar from '@/components/common/FilterBar';
import type { FilterModel } from '@/types/filter';
import StatBadge from '@/components/common/StatBadge';
import EmptyPanel from '@/components/common/EmptyPanel';
import { ROUTES } from '@/router';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import {
  createArray,
  patchFilter,
  recomputeAperture,
  removeArray,
  resetFilter,
  selectArray,
  selectArrayFilter,
  selectArrays,
  selectCurrentArrayId,
  selectStations,
  syncStationCount,
  updateArray,
} from '@/stores/arraySlice';
import { selectInstruments } from '@/stores/instrumentSlice';
import { selectCalibrations, selectReplaces } from '@/stores/calibrationSlice';
import { APERTURE_BUCKETS, ARRAY_STATES, type ArrayState, type SeisArray } from '@/types/array';
import { apertureKm, round } from '@/utils/geo';
import { initDatabase } from '@/utils/db';

interface ArrayFormValues {
  name: string;
  apertureKm: number;
  deployDate: dayjs.Dayjs | null;
  state: ArrayState;
  department: string;
}

export default function ArrayList() {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();
  const [searchParams, setSearchParams] = useSearchParams();

  const arrays = useAppSelector(selectArrays);
  const stations = useAppSelector(selectStations);
  const instruments = useAppSelector(selectInstruments);
  const calibrations = useAppSelector(selectCalibrations);
  const replaces = useAppSelector(selectReplaces);
  const filter = useAppSelector(selectArrayFilter);
  const currentArrayId = useAppSelector(selectCurrentArrayId);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [areaBucket, setAreaBucket] = useState(APERTURE_BUCKETS[0].label);
  const [form] = Form.useForm<ArrayFormValues>();

  // 首次进入时按 URL query 恢复筛选条件
  useEffect(() => {
    dispatch(
      patchFilter({
        keyword: searchParams.get('kw') ?? '',
        states: (searchParams.get('state')?.split(',').filter(Boolean) ?? []) as ArrayState[],
        deployFrom: searchParams.get('from') ?? '',
        deployTo: searchParams.get('to') ?? '',
        minApertureKm: searchParams.get('minAp') ? Number(searchParams.get('minAp')) : null,
        maxApertureKm: searchParams.get('maxAp') ? Number(searchParams.get('maxAp')) : null,
      })
    );
    dispatch(selectArray(currentArrayId ?? (arrays.length > 0 ? arrays[0].id : null)));
    if (arrays.length === 0) void initDatabase();
    // 只在挂载时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const writeQuery = (next: Partial<Record<string, string>>) => {
    const params = new URLSearchParams();
    Object.entries(next).forEach(([key, value]) => {
      if (value && value.length > 0) params.set(key, value);
    });
    setSearchParams(params, { replace: true });
  };

  const filtered = useMemo(() => {
    return arrays.filter((row) => {
      const keyword = filter.keyword.trim();
      if (keyword.length > 0) {
        const haystack = `${row.name}${row.department}${row.state}`;
        if (!haystack.includes(keyword)) return false;
      }
      if (filter.states.length > 0 && !filter.states.includes(row.state)) return false;
      if (filter.deployFrom && row.deployDate < filter.deployFrom) return false;
      if (filter.deployTo && row.deployDate > filter.deployTo) return false;
      if (filter.minApertureKm !== null && row.apertureKm < filter.minApertureKm) return false;
      if (filter.maxApertureKm !== null && row.apertureKm > filter.maxApertureKm) return false;
      return true;
    });
  }, [arrays, filter]);

  /** 台阵卡片统计：台站数、仪器数、标定数、不合格数与实算孔径 */
  const cards = useMemo(
    () =>
      filtered.map((row) => {
        const arrayStations = stations.filter((station) => station.arrayId === row.id);
        const stationIds = new Set(arrayStations.map((station) => station.id));
        const arrayInstruments = instruments.filter((instrument) => stationIds.has(instrument.stationId));
        const instrumentIds = new Set(arrayInstruments.map((instrument) => instrument.id));
        const arrayCalibrations = calibrations.filter((calibration) =>
          instrumentIds.has(calibration.instrumentId)
        );
        const unqualified = arrayCalibrations.filter(
          (calibration) => calibration.responseVerdict === '不合格'
        ).length;
        const pendingReplace = replaces.filter(
          (replace) => instrumentIds.has(replace.instrumentId) && replace.state !== '已复核'
        ).length;
        const computed = apertureKm(
          arrayStations.map((station) => ({
            id: station.id,
            code: station.code,
            lat: station.lat,
            lng: station.lng,
          }))
        );
        return {
          row,
          stationCount: arrayStations.length,
          instrumentCount: arrayInstruments.length,
          calibrationCount: arrayCalibrations.length,
          unqualified,
          pendingReplace,
          computedApertureKm: computed,
          qualifyRate:
            arrayCalibrations.length === 0
              ? 0
              : round(((arrayCalibrations.length - unqualified) / arrayCalibrations.length) * 100, 1),
        };
      }),
    [calibrations, filtered, instruments, replaces, stations]
  );

  const totals = useMemo(
    () => ({
      arrays: cards.length,
      stations: cards.reduce((sum, card) => sum + card.stationCount, 0),
      instruments: cards.reduce((sum, card) => sum + card.instrumentCount, 0),
      unqualified: cards.reduce((sum, card) => sum + card.unqualified, 0),
      pendingReplace: cards.reduce((sum, card) => sum + card.pendingReplace, 0),
    }),
    [cards]
  );

  const filterModel: FilterModel = {
    keyword: filter.keyword,
    states: filter.states,
    deployFrom: filter.deployFrom,
    deployTo: filter.deployTo,
    minApertureKm: filter.minApertureKm,
    maxApertureKm: filter.maxApertureKm,
  };

  const handleFilterChange = (next: FilterModel) => {
    dispatch(
      patchFilter({
        keyword: next.keyword,
        states: ((next.states as string[]) ?? []) as ArrayState[],
        deployFrom: (next.deployFrom as string) ?? '',
        deployTo: (next.deployTo as string) ?? '',
        minApertureKm: (next.minApertureKm as number | null) ?? null,
        maxApertureKm: (next.maxApertureKm as number | null) ?? null,
      })
    );
    writeQuery({
      kw: next.keyword,
      state: ((next.states as string[]) ?? []).join(','),
      from: (next.deployFrom as string) ?? '',
      to: (next.deployTo as string) ?? '',
      minAp: next.minApertureKm === null || next.minApertureKm === undefined ? '' : String(next.minApertureKm),
      maxAp: next.maxApertureKm === null || next.maxApertureKm === undefined ? '' : String(next.maxApertureKm),
    });
  };

  const handleReset = () => {
    dispatch(resetFilter());
    setAreaBucket(APERTURE_BUCKETS[0].label);
    writeQuery({});
  };

  const openCreate = () => {
    setEditingId(null);
    form.setFieldsValue({
      name: '',
      apertureKm: 20,
      deployDate: dayjs(),
      state: '建设中',
      department: '',
    });
    setModalOpen(true);
  };

  const openEdit = (row: SeisArray) => {
    setEditingId(row.id);
    form.setFieldsValue({
      name: row.name,
      apertureKm: row.apertureKm,
      deployDate: dayjs(row.deployDate),
      state: row.state,
      department: row.department,
    });
    setModalOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      const payload = {
        name: values.name.trim(),
        apertureKm: Number(values.apertureKm),
        deployDate: values.deployDate ? values.deployDate.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
        state: values.state,
        department: values.department?.trim() ?? '',
      };
      if (editingId) {
        await dispatch(updateArray({ id: editingId, patch: payload })).unwrap();
        message.success('台阵信息已更新');
      } else {
        const created = await dispatch(createArray(payload)).unwrap();
        dispatch(selectArray(created.id));
        message.success('台阵已新建，可进入台站布设');
      }
      setModalOpen(false);
    } catch (error) {
      message.error(typeof error === 'string' ? error : '保存失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemove = async (row: SeisArray) => {
    await dispatch(removeArray(row.id)).unwrap();
    message.success(`台阵「${row.name}」及其台站、仪器、标定记录已删除`);
  };

  const gotoSections = (row: SeisArray) => {
    dispatch(selectArray(row.id));
    navigate(ROUTES.stations(row.id));
  };

  const handleRecompute = async (row: SeisArray) => {
    await dispatch(syncStationCount(row.id)).unwrap();
    const result = await dispatch(recomputeAperture(row.id)).unwrap();
    message.success(`已按经纬度重算孔径：${result.apertureKm} km`);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <Typography.Title level={4} style={{ margin: '0 0 4px', color: '#1e3a5f' }}>
            台阵与台站台账
          </Typography.Title>
          <p className="gb-hint">
            维护台阵孔径、布设日期与运行状态，台站数与实算孔径自动汇总回显。点击「台站仪器」进入子页面。
          </p>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新建台阵
        </Button>
      </div>

      <FilterBar
        modelValue={filterModel}
        selects={[
          {
            key: 'states',
            label: '运行状态',
            options: ARRAY_STATES.map((state) => ({ label: state, value: state })),
          },
        ]}
        numberRanges={[
          { key: 'minApertureKm', label: '孔径不低于', placeholder: '不限', suffix: 'km' },
          { key: 'maxApertureKm', label: '孔径不超过', placeholder: '不限', suffix: 'km' },
        ]}
        dateRanges={[
          { key: 'deployFrom', label: '布设自' },
          { key: 'deployTo', label: '至' },
        ]}
        keywordPlaceholder="搜索台阵名 / 管理部门"
        onChange={handleFilterChange}
        onReset={handleReset}
        extra={
          <Space size={6}>
            <Select
              style={{ width: 160 }}
              value={areaBucket}
              options={APERTURE_BUCKETS.map((bucket) => ({ label: bucket.label, value: bucket.label }))}
              onChange={(value) => {
                setAreaBucket(value);
                const bucket = APERTURE_BUCKETS.find((item) => item.label === value);
                dispatch(patchFilter({ minApertureKm: bucket?.min ?? null, maxApertureKm: bucket?.max ?? null }));
              }}
            />
            <Button size="small" icon={<SyncOutlined />} onClick={() => void initDatabase()}>
              补齐演示数据
            </Button>
          </Space>
        }
      />

      <div className="gb-stats-row">
        <StatBadge label="筛选后台阵" value={totals.arrays} suffix="个" tone="primary" />
        <StatBadge label="台站总数" value={totals.stations} suffix="个" tone="info" />
        <StatBadge label="仪器总数" value={totals.instruments} suffix="台" tone="default" />
        <StatBadge
          label="不合格标定"
          value={totals.unqualified}
          suffix="次"
          tone={totals.unqualified > 0 ? 'danger' : 'success'}
        />
        <StatBadge
          label="未闭环更换"
          value={totals.pendingReplace}
          suffix="条"
          tone={totals.pendingReplace > 0 ? 'warning' : 'success'}
        />
      </div>

      {cards.length === 0 ? (
        <EmptyPanel
          title={filter.keyword || filter.states.length > 0 ? '没有符合条件的台阵' : '还没有台阵'}
          description="新建第一个台阵后即可布设台站、登记仪器并按次录入标定结果。"
          actionText="新建台阵"
          secondaryText="重置筛选"
          onAction={openCreate}
          onSecondary={handleReset}
        />
      ) : (
        <Row gutter={[14, 14]}>
          {cards.map((card) => (
            <Col key={card.row.id} xs={24} md={12} xl={8}>
              <Card
                hoverable
                style={{
                  borderLeft: `4px solid ${card.unqualified > 0 ? '#c0392b' : '#1e8449'}`,
                }}
                title={
                  <Space>
                    <span style={{ fontWeight: 600 }}>{card.row.name}</span>
                    <Tag color={card.row.state === '运行中' ? 'green' : card.row.state === '建设中' ? 'blue' : 'red'}>
                      {card.row.state}
                    </Tag>
                  </Space>
                }
                extra={<span className="gb-mono gb-hint">{card.row.deployDate}</span>}
              >
                <div className="gb-stats-row" style={{ marginBottom: 10 }}>
                  <StatBadge label="台站" value={card.stationCount} suffix="个" size="small" tone="info" />
                  <StatBadge label="仪器" value={card.instrumentCount} suffix="台" size="small" />
                  <StatBadge
                    label="标定合格率"
                    value={card.qualifyRate}
                    percent={card.qualifyRate}
                    size="small"
                    tone={card.unqualified > 0 ? 'warning' : 'success'}
                  />
                </div>
                <Space direction="vertical" size={4} style={{ fontSize: 13, color: '#5b6b78' }}>
                  <span>
                    登记孔径 <b className="gb-mono">{card.row.apertureKm}</b> km · 实算孔径{' '}
                    <b className="gb-mono">{card.computedApertureKm}</b> km
                  </span>
                  <span>
                    累计标定 <b className="gb-mono">{card.calibrationCount}</b> 次
                    {card.unqualified > 0 ? (
                      <span className="gb-danger"> · 不合格 {card.unqualified} 次</span>
                    ) : null}
                  </span>
                  <span>管理部门：{card.row.department || '未填写'}</span>
                </Space>
                <Space wrap style={{ marginTop: 12 }}>
                  <Button type="primary" size="small" icon={<RightOutlined />} onClick={() => gotoSections(card.row)}>
                    台站仪器
                  </Button>
                  <Button size="small" icon={<SyncOutlined />} onClick={() => void handleRecompute(card.row)}>
                    重算孔径
                  </Button>
                  <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(card.row)}>
                    编辑
                  </Button>
                  <Popconfirm
                    title="删除台阵"
                    description={`将同时删除其台站、仪器、标定与更换记录，确认删除「${card.row.name}」？`}
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => void handleRemove(card.row)}
                  >
                    <Button size="small" danger icon={<DeleteOutlined />}>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              </Card>
            </Col>
          ))}
        </Row>
      )}

      <Card className="gb-panel" size="small" title="台阵一览（表格视图）">
        <Table
          size="small"
          rowKey="id"
          className="gb-table-compact"
          dataSource={filtered}
          pagination={false}
          locale={{ emptyText: <EmptyPanel title="暂无台阵" description="点击「新建台阵」开始录入。" compact /> }}
          columns={[
            { title: '台阵名', dataIndex: 'name', width: 180 },
            {
              title: '状态',
              dataIndex: 'state',
              width: 100,
              render: (state: string) => <Tag>{state}</Tag>,
            },
            { title: '孔径 (km)', dataIndex: 'apertureKm', width: 110, align: 'right', className: 'gb-mono' },
            { title: '台站数', dataIndex: 'stationCount', width: 90, align: 'right', className: 'gb-mono' },
            { title: '布设日期', dataIndex: 'deployDate', width: 120, className: 'gb-mono' },
            { title: '管理部门', dataIndex: 'department', ellipsis: true },
            {
              title: '操作',
              width: 160,
              render: (_: unknown, row: SeisArray) => (
                <Space size={6}>
                  <Button size="small" type="link" onClick={() => gotoSections(row)}>
                    台站
                  </Button>
                  <Button size="small" type="link" onClick={() => openEdit(row)}>
                    编辑
                  </Button>
                  <Button size="small" type="link" danger onClick={() => dispatch(selectArray(row.id))}>
                    设为当前
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <p className="gb-hint">
        当前选中台阵：{arrays.find((row) => row.id === currentArrayId)?.name ?? '未选择'} ·
        孔径按台站两两 Haversine 距离的最大值实算，可直接覆盖登记值（「重算孔径」）。
      </p>

      <Modal
        open={modalOpen}
        title={editingId ? '编辑台阵' : '新建台阵'}
        onCancel={() => setModalOpen(false)}
        onOk={() => void submit()}
        confirmLoading={submitting}
        okText={editingId ? '保存修改' : '新建并布设台站'}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="name" label="台阵名称" rules={[{ required: true, message: '请填写台阵名称' }]}>
            <Input placeholder="如：龙门峡流动台阵" maxLength={40} />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item
                name="apertureKm"
                label="孔径（km）"
                rules={[{ required: true, message: '请填写孔径' }]}
              >
                <InputNumber min={0.1} max={2000} step={0.1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="deployDate"
                label="布设日期"
                rules={[{ required: true, message: '请选择布设日期' }]}
              >
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="state" label="运行状态" rules={[{ required: true }]}>
            <Select options={ARRAY_STATES.map((state) => ({ label: state, value: state }))} />
          </Form.Item>
          <Form.Item name="department" label="管理部门">
            <Input placeholder="如：省地震局监测中心" maxLength={40} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
