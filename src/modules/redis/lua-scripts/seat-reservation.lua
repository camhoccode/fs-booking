--[[
  Single Seat Reservation Script
  Atomically reserves a single seat with hold expiration

  KEYS[1]: showtime:{showtimeId}:seats (Hash containing seat status)
  KEYS[2]: showtime:{showtimeId}:available (Atomic counter)

  ARGV[1]: seat_id (e.g., "A1")
  ARGV[2]: booking_id
  ARGV[3]: hold_expire_time (Unix timestamp)
  ARGV[4]: seat_type (e.g., "standard", "vip", "couple")

  Returns:
    {1, "SUCCESS"} - Seat reserved successfully
    {0, "SEAT_BOOKED"} - Seat is already booked
    {0, "SEAT_HELD"} - Seat is held by another booking
    {0, "SEAT_NOT_FOUND"} - Seat does not exist
]]

local seats_key = KEYS[1]
local available_key = KEYS[2]
local seat_id = ARGV[1]
local booking_id = ARGV[2]
local hold_expire = tonumber(ARGV[3])
local seat_type = ARGV[4]

-- Get current timestamp from Redis server (more accurate than client time)
local now = tonumber(redis.call('TIME')[1])

-- Check if seat exists and get current status
local current_status = redis.call('HGET', seats_key, seat_id)

if current_status then
  local status_data = cjson.decode(current_status)

  -- Seat is permanently booked - cannot reserve
  if status_data.status == 'booked' then
    return {0, 'SEAT_BOOKED'}
  end

  -- Seat is held - check if hold has expired
  if status_data.status == 'held' then
    local held_until = tonumber(status_data.held_until) or 0

    -- Hold is still active - cannot reserve
    if held_until > now then
      return {0, 'SEAT_HELD'}
    end
    -- Hold has expired - can be reserved (falls through to reservation logic)
  end
else
  -- Seat doesn't exist in the hash - return not found
  return {0, 'SEAT_NOT_FOUND'}
end

-- Determine if seat was previously available (for counter adjustment)
local was_available = false
if not current_status then
  was_available = true
else
  local prev_data = cjson.decode(current_status)
  was_available = (prev_data.status == 'available')
end

-- Atomically reserve the seat
local seat_data = cjson.encode({
  status = 'held',
  booking_id = booking_id,
  held_until = hold_expire,
  seat_type = seat_type,
  reserved_at = now
})

redis.call('HSET', seats_key, seat_id, seat_data)

-- Decrement available counter only if seat was previously available
if was_available then
  redis.call('DECR', available_key)
end

return {1, 'SUCCESS'}
