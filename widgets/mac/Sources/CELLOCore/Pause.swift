import Foundation

public enum PauseTimes {
    public static let morningHour = 9

    public static func anHour(from now: Date) -> Date {
        now.addingTimeInterval(60 * 60)
    }

    // 9 in the morning, local time. Before 5 a.m. "tomorrow morning" is still the coming one, today.
    public static func tomorrowMorning(from now: Date, calendar: Calendar = .current) -> Date {
        let hour = calendar.component(.hour, from: now)
        let day = hour < 5 ? now : calendar.date(byAdding: .day, value: 1, to: now) ?? now.addingTimeInterval(24 * 60 * 60)
        return calendar.date(bySettingHour: morningHour, minute: 0, second: 0, of: day) ?? day
    }
}
