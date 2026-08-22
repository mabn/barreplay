#!/usr/bin/env python3
"""H3 (round 2): keep the RunTask timer off the empty-poll path."""
p='/home/mabn/dev/recoil/rts/System/Threading/ThreadPool.cpp'
s=open(p).read()

old_head = """static bool DoTask(int tid, bool async)
{
	#ifndef UNIT_TEST
	SCOPED_MT_TIMER("ThreadPool::RunTask");
	#endif

	ITaskGroup* tg = nullptr;"""
new_head = """static bool DoTask(int tid, bool async)
{
	// [barreplay H3] the RunTask timer used to wrap the whole call, so every
	// EMPTY poll paid two clock reads for nothing — and the worker spin loop
	// plus WaitForFinished's help-spin call DoTask millions of times per second
	// while the queues are dry (5%+ of mid-game CPU sat in __vdso_clock_gettime).
	// Time actual task execution only (below): a profiler-accounting change,
	// with no scheduling or sim-visible effect. It also makes the
	// ThreadPool::RunTask row in the engine's own profile MEAN something —
	// previously it was mostly the cost of measuring idleness.
	ITaskGroup* tg = nullptr;"""
assert old_head in s, "DoTask head anchor"
s = s.replace(old_head, new_head, 1)

# both execution branches: put the timer immediately after the async assert
# the two execution branches order `reschedule` and the assert differently, so
# anchor on the stats block that opens both of them
old_exec = """			#ifdef USE_TASK_STATS_TRACKING
			const uint64_t wdt = tg->GetDeltaTime(spring_now());"""
new_exec = """			#ifndef UNIT_TEST
			SCOPED_MT_TIMER("ThreadPool::RunTask");
			#endif

			#ifdef USE_TASK_STATS_TRACKING
			const uint64_t wdt = tg->GetDeltaTime(spring_now());"""
n = s.count(old_exec)
assert n == 2, f"expected 2 execution branches, found {n}"
s = s.replace(old_exec, new_exec)

old_spin = """	do {
		const auto spinlockEnd = spring_now() + spring_time::fromMilliSecs(500);

		while (!DoTask(tid, false) && !taskGroup->IsFinished() && !exitFlags[tid]) {
			if (spring_now() < spinlockEnd)
				continue;"""
new_spin = """	do {
		const auto spinlockEnd = spring_now() + spring_time::fromMilliSecs(500);

		// [barreplay H3] the 500ms deadline is only an anti-hang fallback, but
		// reading the clock on every empty spin iteration made this loop a large
		// part of the same clock storm. Check it every 64th iteration: the
		// fallback fires microseconds later at worst, and nothing else changes.
		unsigned spinIter = 0;

		while (!DoTask(tid, false) && !taskGroup->IsFinished() && !exitFlags[tid]) {
			if (((++spinIter & 63u) != 0) || spring_now() < spinlockEnd)
				continue;"""
assert old_spin in s, "WaitForFinished spin anchor"
s = s.replace(old_spin, new_spin, 1)
open(p,'w').write(s)
print("H3 applied")
