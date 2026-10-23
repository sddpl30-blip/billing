declare module 'react-dom/client' {
  export function createRoot(el: Element): { render(node: unknown): void };
}

declare module 'recharts' {
  type Any = (props: Record<string, unknown>) => JSX.Element;
  export const ResponsiveContainer: Any;
  export const LineChart: Any;
  export const Line: Any;
  export const BarChart: Any;
  export const Bar: Any;
  export const AreaChart: Any;
  export const Area: Any;
  export const PieChart: Any;
  export const Pie: Any;
  export const Cell: Any;
  export const XAxis: Any;
  export const YAxis: Any;
  export const CartesianGrid: Any;
  export const Tooltip: Any;
  export const Legend: Any;
  export const RadialBarChart: Any;
  export const RadialBar: Any;
  export const ComposedChart: Any;
  export const ReferenceLine: Any;
}

declare module '*.css';
