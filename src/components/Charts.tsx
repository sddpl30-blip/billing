/**
 * The dashboard charts, in their own module.
 *
 * recharts is most of the bundle by weight, and only the manager and
 * committee dashboards draw a chart. Kept here and loaded lazily, a resident
 * — the most common visitor, often on a phone — never downloads it.
 */

import React from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { formatRupee } from '../utils';

export interface CollectionPoint {
  readonly month: string;
  readonly Collected: number;
  readonly Outstanding: number;
}

export interface BudgetPoint {
  readonly head: string;
  readonly Budgeted: number;
  readonly Actual: number;
}

const tick = (compact: boolean) => ({ fontSize: compact ? 9 : 11, fill: 'var(--mv-muted)' });

export const CollectionChart: React.FC<{ data: readonly CollectionPoint[]; compact?: boolean }> = ({
  data, compact = false,
}) => (
  <ResponsiveContainer width="100%" height="100%">
    <AreaChart
      data={[...data]}
      margin={compact ? { top: 5, right: 5, left: -20, bottom: 0 } : { top: 10, right: 10, left: -10, bottom: 0 }}
    >
      {!compact && <CartesianGrid strokeDasharray="3 3" stroke="var(--mv-soft)" />}
      <XAxis dataKey="month" tick={tick(compact)} />
      <YAxis tick={tick(compact)} />
      <Tooltip formatter={(value) => formatRupee(value as number)} />
      <Area type="monotone" dataKey="Collected" stroke="var(--mv-accent)" fillOpacity={0.08} fill="var(--mv-accent)" strokeWidth={compact ? 2.5 : 3} />
      {!compact && (
        <Area type="monotone" dataKey="Outstanding" stroke="var(--mv-ink)" fillOpacity={0.03} fill="var(--mv-ink)" strokeWidth={2} />
      )}
    </AreaChart>
  </ResponsiveContainer>
);

export const BudgetChart: React.FC<{ data: readonly BudgetPoint[]; compact?: boolean }> = ({
  data, compact = false,
}) => (
  <ResponsiveContainer width="100%" height="100%">
    <BarChart
      data={[...data]}
      margin={compact ? { top: 5, right: 5, left: -20, bottom: 0 } : { top: 10, right: 10, left: -10, bottom: 0 }}
    >
      {!compact && <CartesianGrid strokeDasharray="3 3" stroke="var(--mv-soft)" />}
      <XAxis dataKey="head" tick={tick(compact)} />
      <YAxis tick={tick(compact)} />
      <Tooltip formatter={(value) => formatRupee(value as number)} />
      <Bar dataKey="Budgeted" fill="var(--mv-muted)" radius={compact ? [4, 4, 0, 0] : [6, 6, 0, 0]} />
      <Bar dataKey="Actual" fill="var(--mv-accent)" radius={compact ? [4, 4, 0, 0] : [6, 6, 0, 0]} />
    </BarChart>
  </ResponsiveContainer>
);
