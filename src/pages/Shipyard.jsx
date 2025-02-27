import React, { useState } from 'react';

const DockManagementSystem = () => {
  const [currentMonth, setCurrentMonth] = useState('January');
  
  const vessels = [
    { id: 'TBN16', dock: 'DOCK1', startDate: '2025-01-31', endDate: '2025-02-05', type: 'regular' },
    { id: 'TBN1', dock: 'DOCK2', startDate: '2025-02-01', endDate: '2025-02-10', type: 'regular' },
    { id: 'TBN2', dock: 'DOCK2', startDate: '2025-02-08', endDate: '2025-02-20', type: 'special' },
    { id: 'TBN3', dock: 'DOCK2', startDate: '2025-02-15', endDate: '2025-03-05', type: 'regular' },
    { id: 'TBN14', dock: 'FD', startDate: '2025-01-31', endDate: '2025-02-07', type: 'regular' },
    { id: 'TBN15', dock: 'FD', startDate: '2025-02-01', endDate: '2025-02-08', type: 'regular' },
    { id: 'GMS ENDIKU', dock: 'FD', startDate: '2025-02-20', endDate: '2025-03-10', type: 'special' },
  ];

  const docks = [
    { id: 'DOCK1', name: 'DOCK1 (360m x 66m)' },
    { id: 'DOCK2', name: 'DOCK2 (400m x 80m)' },
    { id: 'FD', name: 'FD (375m x 66m)' },
    { id: 'P14', name: 'P14 (450m)' },
    { id: 'Q1', name: 'Q1 (367m)' },
  ];

  const months = ['January', 'February', 'March'];
  const daysInMonth = {
    January: 31,
    February: 28,
    March: 31
  };

  const calculatePosition = (startDate, endDate) => {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const totalDays = 90;
    const dayWidth = 100 / totalDays;
    
    const startOffset = (start.getDate() - 25) * dayWidth;
    const duration = (end - start) / (1000 * 60 * 60 * 24) * dayWidth;
    
    return {
      left: `${startOffset}%`,
      width: `${duration}%`
    };
  };

  return (
    <div className="dock-management">
      <div className="timeline-header">
        {months.map(month => (
          <div key={month} className="month-label">{month} 2025</div>
        ))}
      </div>

      <div className="date-markers">
        {Array.from({ length: 90 }, (_, i) => {
          const date = new Date(2025, 0, 25 + i);
          return (
            <div key={i} className="date-marker">
              {date.getDate()}
            </div>
          );
        })}
      </div>

      {docks.map(dock => (
        <div key={dock.id} className="dock-row">
          <div className="dock-label">{dock.name}</div>
          <div className="dock-timeline">
            <div className="timeline-grid">
              {Array.from({ length: 90 }, (_, i) => (
                <div key={i} className="timeline-grid-line" />
              ))}
            </div>
            {vessels
              .filter(v => v.dock === dock.id)
              .map(vessel => {
                const position = calculatePosition(vessel.startDate, vessel.endDate);
                return (
                  <div
                    key={vessel.id}
                    className={`vessel-block ${vessel.type}`}
                    style={{
                      left: position.left,
                      width: position.width
                    }}
                    title={`${vessel.id}: ${vessel.startDate} to ${vessel.endDate}`}
                  >
                    {vessel.id}
                  </div>
                );
              })}
          </div>
        </div>
      ))}

      <div className="legend">
        <div className="legend-item">
          <div className="legend-color regular"></div>
          <span>Regular Vessel</span>
        </div>
        <div className="legend-item">
          <div className="legend-color special"></div>
          <span>Special Operation</span>
        </div>
      </div>
    </div>
  );
};

export default DockManagementSystem;

