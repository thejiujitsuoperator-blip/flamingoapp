interface Props {
  columns: string[];
  rows: (string | number)[][];
  onRowClick?: (row: (string | number)[]) => void;
  numericColumns?: number[];
}

const looksNumeric = (v: string | number) => typeof v === "number" || /^[-₹\d,.\s]+$/.test(v);

export function DataTable({ columns, rows, onRowClick, numericColumns }: Props) {
  const numeric = new Set(
    numericColumns ?? columns.map((_, i) => i).filter((i) => rows.length > 0 && rows.every((r) => looksNumeric(r[i] ?? ""))),
  );
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={c + i} className={numeric.has(i) ? "num" : undefined}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} onClick={onRowClick ? () => onRowClick(row) : undefined} className={onRowClick ? "clickable" : undefined}>
              {row.map((cell, i) => (
                <td key={i} className={numeric.has(i) ? "num" : undefined}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
